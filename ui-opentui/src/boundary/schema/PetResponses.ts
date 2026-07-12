/** Effect 4 decode boundary for the interactive petdex picker. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const opt = Schema.optionalKey
const UnknownFields = Schema.Record(Str, Schema.Unknown)

export const GalleryPetSchema = Schema.StructWithRest(
  Schema.Struct({
    curated: opt(Schema.Boolean),
    displayName: Str,
    installed: Schema.Boolean,
    slug: Str
  }),
  [UnknownFields]
)

export const PetGalleryResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    active: Str,
    enabled: Schema.Boolean,
    pets: Schema.Array(GalleryPetSchema)
  }),
  [UnknownFields]
)

export const PetSelectResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    displayName: Str,
    ok: Schema.Boolean,
    slug: Str
  }),
  [UnknownFields]
)

export type GalleryPet = typeof GalleryPetSchema.Type
export type PetGalleryResponse = typeof PetGalleryResponseSchema.Type
export type PetSelectResponse = typeof PetSelectResponseSchema.Type

const decodeGallery = Schema.decodeUnknownOption(PetGalleryResponseSchema)
const decodeSelect = Schema.decodeUnknownOption(PetSelectResponseSchema)

function some<A>(value: Option.Option<A>): A | undefined {
  return Option.isSome(value) ? value.value : undefined
}

export const decodePetGalleryResponse = (value: unknown): PetGalleryResponse | undefined => some(decodeGallery(value))
export const decodePetSelectResponse = (value: unknown): PetSelectResponse | undefined => some(decodeSelect(value))
