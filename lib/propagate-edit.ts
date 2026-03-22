import type { AnalysisResult, Character, LocationInfo, NarrativeArc } from '@/types';

export type SnapshotTransform = (r: AnalysisResult) => AnalysisResult;

function nameMatch(a: string, b: string): boolean {
  return a.toLowerCase().trim() === b.toLowerCase().trim();
}

// ── Character transforms ───────────────────────────────────────────────────

const IMPORTANCE_ORDER: Record<string, number> = { main: 3, secondary: 2, minor: 1 };

export function renameCharacter(oldName: string, newName: string): SnapshotTransform {
  return (r) => {
    const characters = r.characters.map((c) => {
      const isTarget = nameMatch(c.name, oldName);
      const updated = isTarget ? { ...c, name: newName } : { ...c };
      if (updated.relationships?.length) {
        updated.relationships = updated.relationships.map((rel) =>
          nameMatch(rel.character, oldName) ? { ...rel, character: newName } : rel,
        );
      }
      return updated;
    });
    const arcs = r.arcs?.map((a) => ({
      ...a,
      characters: a.characters.map((n) => nameMatch(n, oldName) ? newName : n),
    }));
    return { ...r, characters, arcs };
  };
}

export function mergeCharacters(primaryName: string, absorbedName: string): SnapshotTransform {
  return (r) => {
    const primaryIdx = r.characters.findIndex((c) => nameMatch(c.name, primaryName));
    const absorbedIdx = r.characters.findIndex((c) => nameMatch(c.name, absorbedName));

    if (primaryIdx < 0 && absorbedIdx < 0) return r;
    if (primaryIdx >= 0 && absorbedIdx < 0) return r;

    let characters: Character[];

    if (primaryIdx < 0 && absorbedIdx >= 0) {
      // Only absorbed exists → rename to primary
      characters = r.characters.map((c) =>
        nameMatch(c.name, absorbedName) ? { ...c, name: primaryName } : { ...c },
      );
    } else {
      // Both exist → merge into primary
      const primary = { ...r.characters[primaryIdx] };
      const absorbed = r.characters[absorbedIdx];

      const allAliases = new Set([
        ...(primary.aliases ?? []),
        ...(absorbed.aliases ?? []),
        absorbed.name,
      ].map((s) => s.trim()).filter((s) => s && !nameMatch(s, primaryName)));
      primary.aliases = [...allAliases];

      if ((absorbed.description?.length ?? 0) > (primary.description?.length ?? 0)) {
        primary.description = absorbed.description;
      }
      if ((IMPORTANCE_ORDER[absorbed.importance] ?? 0) > (IMPORTANCE_ORDER[primary.importance] ?? 0)) {
        primary.importance = absorbed.importance;
      }

      const relsSeen = new Set(primary.relationships?.map((rel) => rel.character.toLowerCase()) ?? []);
      for (const rel of absorbed.relationships ?? []) {
        if (!relsSeen.has(rel.character.toLowerCase())) {
          primary.relationships = [...(primary.relationships ?? []), rel];
          relsSeen.add(rel.character.toLowerCase());
        }
      }

      characters = r.characters.filter((_, i) => i !== absorbedIdx);
      characters = characters.map((c) => nameMatch(c.name, primaryName) ? primary : { ...c });
    }

    // Update relationship refs
    characters = characters.map((c) => ({
      ...c,
      relationships: c.relationships?.map((rel) =>
        nameMatch(rel.character, absorbedName) ? { ...rel, character: primaryName } : rel,
      ).filter((rel) => !nameMatch(rel.character, c.name)),
    }));

    const arcs = r.arcs?.map((a) => ({
      ...a,
      characters: [...new Set(a.characters.map((n) => nameMatch(n, absorbedName) ? primaryName : n))],
    }));

    return { ...r, characters, arcs };
  };
}

export function splitCharacter(originalName: string, nameA: string, nameB: string): SnapshotTransform {
  return (r) => {
    const idx = r.characters.findIndex((c) => nameMatch(c.name, originalName));
    if (idx < 0) return r;

    const original = r.characters[idx];
    const cloneA: Character = { ...original, name: nameA, aliases: [] };
    const cloneB: Character = { ...original, name: nameB, aliases: [] };

    const characters = [
      ...r.characters.slice(0, idx),
      cloneA,
      cloneB,
      ...r.characters.slice(idx + 1),
    ].map((c) => ({
      ...c,
      relationships: c.relationships?.map((rel) =>
        nameMatch(rel.character, originalName) ? { ...rel, character: nameA } : rel,
      ),
    }));

    const arcs = r.arcs?.map((a) => ({
      ...a,
      characters: a.characters.flatMap((n) => nameMatch(n, originalName) ? [nameA, nameB] : [n]),
    }));

    return { ...r, characters, arcs };
  };
}

export function deleteCharacter(name: string): SnapshotTransform {
  return (r) => {
    const characters = r.characters
      .filter((c) => !nameMatch(c.name, name))
      .map((c) => ({
        ...c,
        relationships: c.relationships?.filter((rel) => !nameMatch(rel.character, name)),
      }));
    const arcs = r.arcs?.map((a) => ({
      ...a,
      characters: a.characters.filter((n) => !nameMatch(n, name)),
    }));
    return { ...r, characters, arcs };
  };
}

// ── Location transforms ────────────────────────────────────────────────────

export function renameLocation(oldName: string, newName: string): SnapshotTransform {
  return (r) => {
    const locations = r.locations?.map((l) => {
      const isTarget = nameMatch(l.name, oldName);
      const updated = isTarget ? { ...l, name: newName } : { ...l };
      if (updated.parentLocation && nameMatch(updated.parentLocation, oldName)) {
        updated.parentLocation = newName;
      }
      if (updated.relationships?.length) {
        updated.relationships = updated.relationships.map((rel) =>
          nameMatch(rel.location, oldName) ? { ...rel, location: newName } : rel,
        );
      }
      return updated;
    });
    const characters = r.characters.map((c) =>
      c.currentLocation && nameMatch(c.currentLocation, oldName)
        ? { ...c, currentLocation: newName }
        : c,
    );
    return { ...r, characters, locations };
  };
}

export function mergeLocations(primaryName: string, absorbedName: string): SnapshotTransform {
  return (r) => {
    const locs = r.locations ?? [];
    const primaryIdx = locs.findIndex((l) => nameMatch(l.name, primaryName));
    const absorbedIdx = locs.findIndex((l) => nameMatch(l.name, absorbedName));

    let locations: LocationInfo[];

    if (absorbedIdx < 0) {
      // Nothing to merge in the locations array — keep as-is
      locations = locs;
    } else if (primaryIdx < 0) {
      // Only absorbed exists → rename to primary
      locations = locs.map((l) =>
        nameMatch(l.name, absorbedName) ? { ...l, name: primaryName } : { ...l },
      );
    } else {
      // Both exist → merge absorbed into primary
      const primary = { ...locs[primaryIdx] };
      const absorbed = locs[absorbedIdx];

      const allAliases = new Set([
        ...(primary.aliases ?? []),
        ...(absorbed.aliases ?? []),
        absorbed.name,
      ].map((s) => s.trim()).filter((s) => s && !nameMatch(s, primaryName)));
      primary.aliases = allAliases.size > 0 ? [...allAliases] : undefined;

      if ((absorbed.description?.length ?? 0) > (primary.description?.length ?? 0)) {
        primary.description = absorbed.description;
      }

      const relsSeen = new Set(primary.relationships?.map((rel) => rel.location.toLowerCase()) ?? []);
      for (const rel of absorbed.relationships ?? []) {
        if (!relsSeen.has(rel.location.toLowerCase())) {
          primary.relationships = [...(primary.relationships ?? []), rel];
          relsSeen.add(rel.location.toLowerCase());
        }
      }
      if (!primary.arc && absorbed.arc) primary.arc = absorbed.arc;

      locations = locs.filter((_, i) => i !== absorbedIdx);
      locations = locations.map((l) => nameMatch(l.name, primaryName) ? primary : { ...l });
    }

    locations = locations.map((l) => ({
      ...l,
      parentLocation: l.parentLocation && nameMatch(l.parentLocation, absorbedName)
        ? primaryName : l.parentLocation,
      relationships: l.relationships?.map((rel) =>
        nameMatch(rel.location, absorbedName) ? { ...rel, location: primaryName } : rel,
      ).filter((rel) => !nameMatch(rel.location, l.name)),
    }));

    // Clear self-referential parent
    locations = locations.map((l) =>
      l.parentLocation && nameMatch(l.parentLocation, l.name) ? { ...l, parentLocation: undefined } : l,
    );

    const characters = r.characters.map((c) =>
      c.currentLocation && nameMatch(c.currentLocation, absorbedName)
        ? { ...c, currentLocation: primaryName }
        : c,
    );

    return { ...r, characters, locations };
  };
}

export function splitLocation(originalName: string, nameA: string, nameB: string): SnapshotTransform {
  return (r) => {
    const locs = r.locations ?? [];
    const idx = locs.findIndex((l) => nameMatch(l.name, originalName));
    if (idx < 0) return r;

    const original = locs[idx];
    const cloneA: LocationInfo = { ...original, name: nameA, aliases: undefined };
    const cloneB: LocationInfo = { ...original, name: nameB, aliases: undefined };

    const locations = [
      ...locs.slice(0, idx),
      cloneA,
      cloneB,
      ...locs.slice(idx + 1),
    ].map((l) => ({
      ...l,
      parentLocation: l.parentLocation && nameMatch(l.parentLocation, originalName)
        ? nameA : l.parentLocation,
      relationships: l.relationships?.map((rel) =>
        nameMatch(rel.location, originalName) ? { ...rel, location: nameA } : rel,
      ),
    }));

    const characters = r.characters.map((c) =>
      c.currentLocation && nameMatch(c.currentLocation, originalName)
        ? { ...c, currentLocation: nameA }
        : c,
    );

    return { ...r, characters, locations };
  };
}

export function setParentLocation(childName: string, parentName: string | undefined): SnapshotTransform {
  return (r) => {
    const locations = (r.locations ?? []).map((l) => {
      if (nameMatch(l.name, childName)) {
        const updated = { ...l, parentLocation: parentName || undefined };
        // Add/update "part of" relationship on child
        let rels = [...(updated.relationships ?? [])];
        rels = rels.filter((rel) => rel.relationship !== 'part of');
        if (parentName) rels.push({ location: parentName, relationship: 'part of' });
        updated.relationships = rels.length > 0 ? rels : undefined;
        return updated;
      }
      if (parentName && nameMatch(l.name, parentName)) {
        // Add "contains" relationship on parent
        let rels = [...(l.relationships ?? [])];
        if (!rels.some((rel) => rel.relationship === 'contains' && nameMatch(rel.location, childName))) {
          rels.push({ location: childName, relationship: 'contains' });
        }
        return { ...l, relationships: rels };
      }
      return l;
    });
    return { ...r, locations };
  };
}

export function deleteLocation(name: string): SnapshotTransform {
  return (r) => {
    const locations = (r.locations ?? [])
      .filter((l) => !nameMatch(l.name, name))
      .map((l) => ({
        ...l,
        parentLocation: l.parentLocation && nameMatch(l.parentLocation, name)
          ? undefined : l.parentLocation,
        relationships: l.relationships?.filter((rel) => !nameMatch(rel.location, name)),
      }));
    const characters = r.characters.map((c) =>
      c.currentLocation && nameMatch(c.currentLocation, name)
        ? { ...c, currentLocation: 'Unknown' }
        : c,
    );
    return { ...r, characters, locations: locations.length > 0 ? locations : undefined };
  };
}

// ── Arc transforms ─────────────────────────────────────────────────────────

export function renameArc(oldName: string, newName: string): SnapshotTransform {
  return (r) => {
    const arcs = r.arcs?.map((a) =>
      nameMatch(a.name, oldName) ? { ...a, name: newName } : a,
    );
    const locations = r.locations?.map((l) =>
      l.arc && nameMatch(l.arc, oldName) ? { ...l, arc: newName } : l,
    );
    return { ...r, arcs, locations };
  };
}

export function mergeArcs(primaryName: string, absorbedName: string): SnapshotTransform {
  return (r) => {
    const arcs = r.arcs ?? [];
    const primaryIdx = arcs.findIndex((a) => nameMatch(a.name, primaryName));
    const absorbedIdx = arcs.findIndex((a) => nameMatch(a.name, absorbedName));

    if (primaryIdx < 0 && absorbedIdx < 0) return r;
    if (primaryIdx >= 0 && absorbedIdx < 0) return r;

    let newArcs: NarrativeArc[];

    if (primaryIdx < 0 && absorbedIdx >= 0) {
      newArcs = arcs.map((a) =>
        nameMatch(a.name, absorbedName) ? { ...a, name: primaryName } : a,
      );
    } else {
      const primary = { ...arcs[primaryIdx] };
      const absorbed = arcs[absorbedIdx];

      primary.characters = [...new Set([...primary.characters, ...absorbed.characters])];
      if ((absorbed.summary?.length ?? 0) > (primary.summary?.length ?? 0)) {
        primary.summary = absorbed.summary;
      }
      const statusOrder: Record<string, number> = { active: 3, dormant: 2, resolved: 1 };
      if ((statusOrder[absorbed.status] ?? 0) > (statusOrder[primary.status] ?? 0)) {
        primary.status = absorbed.status;
      }

      newArcs = arcs.filter((_, i) => i !== absorbedIdx);
      newArcs = newArcs.map((a) => nameMatch(a.name, primaryName) ? primary : a);
    }

    const locations = r.locations?.map((l) =>
      l.arc && nameMatch(l.arc, absorbedName) ? { ...l, arc: primaryName } : l,
    );

    return { ...r, arcs: newArcs.length > 0 ? newArcs : undefined, locations };
  };
}

export function splitArc(originalName: string, nameA: string, nameB: string): SnapshotTransform {
  return (r) => {
    const arcs = r.arcs ?? [];
    const idx = arcs.findIndex((a) => nameMatch(a.name, originalName));
    if (idx < 0) return r;

    const original = arcs[idx];
    const cloneA: NarrativeArc = { ...original, name: nameA };
    const cloneB: NarrativeArc = { ...original, name: nameB };

    const newArcs = [
      ...arcs.slice(0, idx),
      cloneA,
      cloneB,
      ...arcs.slice(idx + 1),
    ];

    const locations = r.locations?.map((l) =>
      l.arc && nameMatch(l.arc, originalName) ? { ...l, arc: nameA } : l,
    );

    return { ...r, arcs: newArcs, locations };
  };
}

export function deleteArc(name: string): SnapshotTransform {
  return (r) => {
    const arcs = (r.arcs ?? []).filter((a) => !nameMatch(a.name, name));
    const locations = r.locations?.map((l) =>
      l.arc && nameMatch(l.arc, name) ? { ...l, arc: undefined } : l,
    );
    return { ...r, arcs: arcs.length > 0 ? arcs : undefined, locations };
  };
}
