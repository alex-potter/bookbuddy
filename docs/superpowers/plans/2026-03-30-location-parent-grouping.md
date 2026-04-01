# Location Parent Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-reconciliation LLM pass that groups sub-locations under canonical parent locations, absorbing trivial sub-locations and assigning `parentLocation` on meaningful ones.

**Architecture:** New `lib/group-locations.ts` module with system prompt, user prompt builder, and deterministic application logic. Called from both `runMultiPassFull()` and `runMultiPassDelta()` in `app/api/analyze/route.ts` after reconciliation/dedup, before returning.

**Tech Stack:** TypeScript, Next.js API route, LLM via existing `callAndParseJSON` in route.ts

---

### Task 1: Create `lib/group-locations.ts` — Prompt and Schema

**Files:**
- Create: `lib/group-locations.ts`

- [ ] **Step 1: Create the file with system prompt, schema, and types**

```typescript
import type { Character, LocationInfo } from '@/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LocationGroup {
  parentIndex: number;
  absorb: number[];
  children: number[];
  reason: string;
}

export interface GroupLocationResult {
  groups: LocationGroup[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export const LOC_GROUP_SYSTEM = `You are a location hierarchy analyst for a literary reading companion.
You review a list of extracted locations and identify sub-locations that
belong to a larger parent location. Your output must be valid JSON and nothing else.

RULES:
- Base your analysis ONLY on the location data provided. Do NOT use external knowledge.
- A sub-location is a room, section, deck, district, or area that is clearly
  part of a larger named place in the list.
- "absorb" = trivial sub-location (room, corridor, cockpit) — merge into parent,
  its description/events fold into the parent.
- "child" = meaningfully distinct sub-location (docks, market district) — keep
  as separate entry but set its parentLocation to the parent.
- Only group when confident. When in doubt, leave the location ungrouped.
- Do NOT create parent locations that aren't already in the list.`;

export const LOC_GROUP_SCHEMA = `{
  "groups": [
    {
      "parentIndex": 0,
      "absorb": [3, 5],
      "children": [7],
      "reason": "Brief explanation"
    }
  ]
}`;
```

- [ ] **Step 2: Commit**

```bash
git add lib/group-locations.ts
git commit -m "feat: add location grouping prompt and types"
```

---

### Task 2: Add User Prompt Builder to `lib/group-locations.ts`

**Files:**
- Modify: `lib/group-locations.ts`

- [ ] **Step 1: Add the `buildLocationGroupPrompt` function**

Append to the end of `lib/group-locations.ts`:

```typescript
// ─── Prompt builder ─────────────────────────────────────────────────────────

export function buildLocationGroupPrompt(
  bookTitle: string,
  bookAuthor: string,
  locations: LocationInfo[],
  characters: Character[],
): string {
  const locBlock = locations.map((l, i) => {
    const aliases = l.aliases?.length ? l.aliases.join(', ') : 'none';
    const parent = l.parentLocation ?? 'none';
    return `#${i}: ${l.name}
  Aliases: ${aliases}
  Parent: ${parent}
  Description: ${l.description ?? 'No description'}
  Recent events: ${l.recentEvents || 'None'}`;
  }).join('\n\n');

  // Character-at-location cross-reference
  const locMap = new Map<string, string[]>();
  for (const c of characters) {
    const loc = c.currentLocation ?? 'Unknown';
    if (!locMap.has(loc)) locMap.set(loc, []);
    locMap.get(loc)!.push(c.name);
  }
  const crossRef = [...locMap.entries()]
    .map(([loc, names]) => `  ${loc}: ${names.join(', ')}`)
    .join('\n');

  return `BOOK: "${bookTitle}" by ${bookAuthor}

LOCATION LIST (${locations.length} locations):
${locBlock}

CHARACTERS AT EACH LOCATION:
${crossRef}

Review these locations and identify sub-locations that belong to a larger parent location already in the list.
- "absorb": trivial sub-locations (rooms, corridors, cockpits) that should be merged into the parent.
- "children": meaningfully distinct sub-locations (docks, markets, districts) that should keep their own entry but have parentLocation set.

If no grouping is needed, return {"groups": []}.

Return ONLY a JSON object (no markdown fences, no explanation):
${LOC_GROUP_SCHEMA}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/group-locations.ts
git commit -m "feat: add location grouping prompt builder"
```

---

### Task 3: Add Application Logic to `lib/group-locations.ts`

**Files:**
- Modify: `lib/group-locations.ts`

- [ ] **Step 1: Add the `applyLocationGroups` function**

Append to the end of `lib/group-locations.ts`:

```typescript
// ─── Application logic ─────────────────────────────────────────────────────

export function applyLocationGroups(
  locations: LocationInfo[],
  characters: Character[],
  groups: LocationGroup[],
): { locations: LocationInfo[]; characters: Character[] } {
  if (!groups.length) return { locations, characters };

  const updatedLocations = locations.map((l) => ({ ...l }));
  let updatedCharacters = characters.map((c) => ({ ...c }));
  const absorbed = new Set<number>();
  const claimed = new Set<number>(); // indices already assigned to a group

  for (const group of groups) {
    // Validate parentIndex
    if (group.parentIndex < 0 || group.parentIndex >= updatedLocations.length) continue;
    if (claimed.has(group.parentIndex)) continue;
    claimed.add(group.parentIndex);

    const parent = updatedLocations[group.parentIndex];

    // Process absorptions
    for (const idx of (group.absorb ?? [])) {
      if (idx < 0 || idx >= updatedLocations.length) continue;
      if (claimed.has(idx)) continue;
      claimed.add(idx);

      const sub = updatedLocations[idx];

      // Append recentEvents
      if (sub.recentEvents) {
        parent.recentEvents = parent.recentEvents
          ? `${parent.recentEvents}; ${sub.recentEvents}`
          : sub.recentEvents;
      }

      // Append description if it adds new info
      if (sub.description && parent.description && !parent.description.toLowerCase().includes(sub.description.toLowerCase().slice(0, 30))) {
        parent.description = `${parent.description} ${sub.description}`;
      }

      // Add sub-location name + aliases to parent aliases
      const parentAliases = new Set((parent.aliases ?? []).map((a) => a.toLowerCase()));
      if (!parentAliases.has(sub.name.toLowerCase()) && sub.name.toLowerCase() !== parent.name.toLowerCase()) {
        parent.aliases = [...(parent.aliases ?? []), sub.name];
      }
      for (const alias of (sub.aliases ?? [])) {
        if (!parentAliases.has(alias.toLowerCase()) && alias.toLowerCase() !== parent.name.toLowerCase()) {
          parent.aliases = [...(parent.aliases ?? []), alias];
          parentAliases.add(alias.toLowerCase());
        }
      }

      // Remap characters at this sub-location
      const subNameLower = sub.name.toLowerCase();
      updatedCharacters = updatedCharacters.map((c) => {
        if (c.currentLocation?.toLowerCase() === subNameLower) {
          return {
            ...c,
            currentLocation: parent.name,
            recentEvents: c.recentEvents
              ? `${c.recentEvents}; previously in ${sub.name}`
              : `previously in ${sub.name}`,
          };
        }
        return c;
      });

      absorbed.add(idx);
    }

    // Process children
    for (const idx of (group.children ?? [])) {
      if (idx < 0 || idx >= updatedLocations.length) continue;
      if (claimed.has(idx)) continue;
      claimed.add(idx);

      updatedLocations[idx].parentLocation = parent.name;
    }
  }

  // Remove absorbed locations
  const finalLocations = updatedLocations.filter((_, i) => !absorbed.has(i));

  return { locations: finalLocations, characters: updatedCharacters };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/group-locations.ts
git commit -m "feat: add applyLocationGroups logic"
```

---

### Task 4: Add `groupLocations` Orchestrator to `lib/group-locations.ts`

**Files:**
- Modify: `lib/group-locations.ts`

This is the main exported function that the route will call. It uses `CallAndParseFn` from reconcile.ts to make the LLM call, matching the pattern used by `reconcileResult`.

- [ ] **Step 1: Add import for `CallAndParseFn` and add the `groupLocations` function**

Add import at the top of `lib/group-locations.ts`:

```typescript
import type { CallAndParseFn } from '@/lib/reconcile';
```

Append to the end of the file:

```typescript
// ─── Orchestrator ───────────────────────────────────────────────────────────

export async function groupLocations(
  locations: LocationInfo[],
  characters: Character[],
  bookTitle: string,
  bookAuthor: string,
  callAndParse: CallAndParseFn,
): Promise<{ locations: LocationInfo[]; characters: Character[] }> {
  if (!locations?.length || locations.length < 2) {
    return { locations, characters };
  }

  console.log(`[analyze] Location grouping: evaluating ${locations.length} locations`);

  let result: GroupLocationResult | null = null;
  try {
    result = await callAndParse<GroupLocationResult>(
      LOC_GROUP_SYSTEM,
      buildLocationGroupPrompt(bookTitle, bookAuthor, locations, characters),
      'loc-group',
    );
  } catch (err) {
    console.log(`[analyze] Location grouping failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { locations, characters };
  }

  if (!result?.groups?.length) {
    console.log('[analyze] Location grouping: no groups identified');
    return { locations, characters };
  }

  const { locations: grouped, characters: remapped } = applyLocationGroups(locations, characters, result.groups);

  const absorbedCount = locations.length - grouped.length;
  const childCount = result.groups.reduce((sum, g) => sum + (g.children?.length ?? 0), 0);
  console.log(`[analyze] Location grouping: ${locations.length} → ${grouped.length} locations (${absorbedCount} absorbed, ${childCount} children assigned)`);

  return { locations: grouped, characters: remapped };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/group-locations.ts
git commit -m "feat: add groupLocations orchestrator"
```

---

### Task 5: Integrate into `runMultiPassFull()`

**Files:**
- Modify: `app/api/analyze/route.ts:1641-1644`

- [ ] **Step 1: Add import at the top of route.ts**

Find the existing import block near the top of `app/api/analyze/route.ts` and add:

```typescript
import { groupLocations } from '@/lib/group-locations';
```

- [ ] **Step 2: Insert the grouping step after the final dedup on line 1642**

Note: `CallAndParseFn` is already imported from `@/lib/reconcile` in route.ts (line 3).

Find this code in `runMultiPassFull()`:

```typescript
  // Final location dedup (catches any remaining duplicates after reconciliation)
  reconciled = { ...reconciled, locations: deduplicateLocations(reconciled.locations) };

  return { result: reconciled, totalRateLimitMs };
```

Replace with:

```typescript
  // Final location dedup (catches any remaining duplicates after reconciliation)
  reconciled = { ...reconciled, locations: deduplicateLocations(reconciled.locations) };

  // Location parent grouping: absorb trivial sub-locations, assign parentLocation on children
  if (reconciled.locations?.length) {
    const callAndParse: CallAndParseFn = async <T>(system: string, userPrompt: string, label: string) => {
      const { result, rateLimitWaitMs: rl } = await callAndParseJSON<T>(system, userPrompt, config, label, config.provider === 'ollama' ? 4096 : undefined, contextWindow);
      totalRateLimitMs += rl;
      return result;
    };
    const groupResult = await groupLocations(reconciled.locations, reconciled.characters, bookTitle, bookAuthor, callAndParse);
    reconciled = { ...reconciled, locations: groupResult.locations, characters: groupResult.characters };
  }

  return { result: reconciled, totalRateLimitMs };
```

- [ ] **Step 3: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds with no type errors in route.ts or group-locations.ts

- [ ] **Step 4: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat: integrate location grouping into full analysis pipeline"
```

---

### Task 6: Integrate into `runMultiPassDelta()`

**Files:**
- Modify: `app/api/analyze/route.ts:1755-1758`

- [ ] **Step 1: Insert the grouping step after `inferParentLocations` in `runMultiPassDelta()`**

Find this code in `runMultiPassDelta()`:

```typescript
  const hierarchicalLocations = labeledLocations ? inferParentLocations(labeledLocations) : labeledLocations;

  console.log(`[analyze] Delta complete: ${finalResult.characters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${finalResult.locations?.length ?? 0} locs`);
  return { result: { ...finalResult, locations: hierarchicalLocations }, totalRateLimitMs };
```

Replace with:

```typescript
  const hierarchicalLocations = labeledLocations ? inferParentLocations(labeledLocations) : labeledLocations;

  // Location parent grouping: absorb trivial sub-locations, assign parentLocation on children
  let groupedLocations = hierarchicalLocations;
  let groupedCharacters = finalResult.characters;
  if (hierarchicalLocations?.length) {
    const callAndParse: CallAndParseFn = async <T>(system: string, userPrompt: string, label: string) => {
      const { result, rateLimitWaitMs: rl } = await callAndParseJSON<T>(system, userPrompt, config, label, config.provider === 'ollama' ? 4096 : undefined, contextWindow);
      totalRateLimitMs += rl;
      return result;
    };
    const groupResult = await groupLocations(hierarchicalLocations, finalResult.characters, bookTitle, bookAuthor, callAndParse);
    groupedLocations = groupResult.locations;
    groupedCharacters = groupResult.characters;
  }

  console.log(`[analyze] Delta complete: ${groupedCharacters.length} chars, ${finalResult.arcs?.length ?? 0} arcs, ${groupedLocations?.length ?? 0} locs`);
  return { result: { ...finalResult, locations: groupedLocations, characters: groupedCharacters }, totalRateLimitMs };
```

Note: `CallAndParseFn` is already imported from `@/lib/reconcile` in route.ts (line 3) — no new import needed.

- [ ] **Step 2: Verify the build compiles**

Run: `npx next build`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Commit**

```bash
git add app/api/analyze/route.ts
git commit -m "feat: integrate location grouping into delta analysis pipeline"
```

---

### Task 7: Manual End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test with a book that has sub-locations**

Open BookBuddy in the browser. Load a book known to produce sub-locations (e.g., an Expanse novel). Analyze a chapter. Check the browser console and server console for:

```
[analyze] Location grouping: evaluating N locations
[analyze] Location grouping: N → M locations (K absorbed, J children assigned)
```

Verify:
- Absorbed sub-locations no longer appear as separate entries in the location list
- Their names appear in the parent's aliases
- Characters previously at absorbed sub-locations now show the parent as `currentLocation`
- Child sub-locations still appear but have `parentLocation` set
- The feature works with both cloud and local (Ollama) models

- [ ] **Step 3: Test the no-op case**

Analyze a chapter from a book with clean, distinct locations (no sub-locations). Verify the log shows:

```
[analyze] Location grouping: no groups identified
```

And the location list is unchanged.

- [ ] **Step 4: Final commit and push**

```bash
git add -A
git push origin main
```
