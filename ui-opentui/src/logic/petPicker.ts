import type { GalleryPet, PetGalleryResponse } from '../boundary/schema/PetResponses.ts'

export const PET_VISIBLE_ROWS = 10

function rankPet(pet: GalleryPet, gallery: Pick<PetGalleryResponse, 'active' | 'enabled'>): number {
  return (gallery.enabled && pet.slug === gallery.active ? 4 : 0) + (pet.installed ? 2 : 0) + (pet.curated ? 1 : 0)
}

/** Filter and rank exactly like the Ink picker: active, installed, curated, then the rest. */
export function visiblePets(gallery: PetGalleryResponse | undefined, query: string): readonly GalleryPet[] {
  if (!gallery) return []
  const needle = query.trim().toLowerCase()
  return gallery.pets
    .filter(pet => !/^clawd(-|$)/i.test(pet.slug))
    .filter(pet => !needle || pet.slug.toLowerCase().includes(needle) || pet.displayName.toLowerCase().includes(needle))
    .map((pet, index) => ({ index, pet, rank: rankPet(pet, gallery) }))
    .sort((left, right) => right.rank - left.rank || left.index - right.index)
    .map(row => row.pet)
}

export function petCursor(count: number, current: number, delta: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), current + delta))
}

export function petWindowOffset(count: number, selected: number, visible: number = PET_VISIBLE_ROWS): number {
  return Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible))
}

export function petWindow<T>(
  rows: readonly T[],
  selected: number,
  visible: number = PET_VISIBLE_ROWS
): { rows: readonly T[]; offset: number } {
  const offset = petWindowOffset(rows.length, selected, visible)
  return { rows: rows.slice(offset, offset + visible), offset }
}

export function petMarker(pet: GalleryPet, gallery: Pick<PetGalleryResponse, 'active' | 'enabled'>): string {
  if (gallery.enabled && pet.slug === gallery.active) return '●'
  return pet.installed ? '✓' : ' '
}

export function petTag(pet: GalleryPet): string {
  return pet.installed || !pet.curated ? '' : ' · official'
}
