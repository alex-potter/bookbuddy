# Location Parent Grouping Design

**Date:** 2026-03-30
**Status:** Approved

## Problem

The LLM extraction prompts instruct the model to prefer broad canonical place names over sub-locations, but sub-locations still leak through (e.g., "rocinante engineering", "rocinante cockpit", "eros hotel room"). These clutter the location list and fragment what should be a single coherent entry.

## Solution

Add a post-reconciliation LLM pass that reviews the full location list and groups sub-locations under their canonical parents. This runs after every chapter analysis (both full and delta pipelines).

## Decisions

- **When:** After each chapter's analysis completes, as part of the post-processing pipeline (after reconciliation/dedup, before returning the final result)
- **Merge strategy:** Selective — trivial sub-locations (rooms, corridors) are absorbed into the parent; meaningfully distinct sub-locations (docks, markets) are kept as children with `parentLocation` set
- **Character remapping:** When a sub-location is absorbed, characters at that sub-location get `currentLocation` set to the parent, with the original sub-location name appended to `recentEvents`
- **Provider support:** Runs for all LLM providers including Ollama local models — no skip conditions
- **Conflict resolution:** Latest grouping wins — overwrites any existing `parentLocation` assignments
- **Architecture:** Separate LLM call after reconciliation, not merged into the reconciliation prompt

## New File: `lib/group-locations.ts`

### System Prompt

Same prompt for all providers (kept concise for local model compatibility):

```
You are a location hierarchy analyst for a literary reading companion.
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
- Do NOT create parent locations that aren't already in the list.
```

### Response Schema

```json
{
  "groups": [
    {
      "parentIndex": 0,
      "absorb": [3, 5],
      "children": [7],
      "reason": "Brief explanation"
    }
  ]
}
```

### User Prompt

Provides the LLM with:
1. Book title and author
2. Numbered location list with names, aliases, descriptions, recentEvents, and existing parentLocation
3. Character-at-location cross-reference

## Application Logic

### Absorbed sub-locations:
1. Append sub-location's `recentEvents` to parent's `recentEvents` (semicolon-separated)
2. If sub-location's `description` adds info not in the parent's, append it to the parent's description
3. Add sub-location's name and aliases to parent's `aliases` array
4. Remove sub-location from location list
5. Remap characters whose `currentLocation` matched the absorbed sub-location:
   - Set `currentLocation` to the parent name
   - Append original sub-location name to the character's `recentEvents` (e.g., "previously in rocinante cockpit")

### Child sub-locations:
1. Set `parentLocation` on the child to the parent's `name`
2. Keep child in the location list unchanged otherwise

### Edge cases:
- Out-of-bounds indices: skip that group silently
- Location in multiple groups: first group wins
- Empty `groups: []`: no-op (expected for chapters with clean locations)
- LLM failure or unparseable JSON: return inputs unchanged (non-fatal)

## Pipeline Integration

### Function Signature

```typescript
async function groupLocations(
  locations: LocationInfo[],
  characters: Character[],
  bookTitle: string,
  bookAuthor: string,
  config: AnalyzeConfig,
  contextWindow?: number,
): Promise<{ locations: LocationInfo[]; characters: Character[]; rateLimitWaitMs: number }>
```

### Insertion Points

**`runMultiPassFull()`** — after final location dedup (line ~1642), before return:
```
final dedup → groupLocations() → return
```

**`runMultiPassDelta()`** — after `inferParentLocations` (line ~1755), before return:
```
inferParentLocations → groupLocations() → return
```

### Logging

```
[analyze] Location grouping: N locations → M locations (K absorbed, J children assigned)
```

### Error Handling

If the LLM call fails or returns unparseable JSON, the function returns the inputs unchanged. This matches the existing resilience pattern for Ollama (see commit 7aaaa99).
