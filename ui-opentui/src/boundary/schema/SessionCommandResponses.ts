/** Effect 4 decode boundaries for live session-maintenance slash commands. */
import { Option, Schema } from 'effect'

const Str = Schema.String
const Num = Schema.Number
const opt = Schema.optionalKey

export const SessionStatusResponseSchema = Schema.Struct({ output: Str })
export type SessionStatusResponse = typeof SessionStatusResponseSchema.Type

export const SessionTitleResponseSchema = Schema.Struct({
  pending: opt(Schema.Boolean),
  session_key: opt(Str),
  title: Str
})
export type SessionTitleResponse = typeof SessionTitleResponseSchema.Type

export const SessionSaveResponseSchema = Schema.Struct({ file: Str })
export type SessionSaveResponse = typeof SessionSaveResponseSchema.Type

export const ReloadEnvResponseSchema = Schema.Struct({ updated: Num })
export type ReloadEnvResponse = typeof ReloadEnvResponseSchema.Type

const SkillChangeSchema = Schema.Struct({
  description: opt(Str),
  name: Str
})

export const SkillsReloadResponseSchema = Schema.Struct({
  output: Str,
  result: Schema.Struct({
    added: opt(Schema.Array(SkillChangeSchema)),
    commands: opt(Num),
    removed: opt(Schema.Array(SkillChangeSchema)),
    total: opt(Num),
    unchanged: opt(Schema.Array(Str))
  })
})
export type SkillsReloadResponse = typeof SkillsReloadResponseSchema.Type

const CommandPairSchema = Schema.Tuple([Str, Str])
const CommandCategorySchema = Schema.Struct({
  name: Str,
  pairs: Schema.Array(CommandPairSchema)
})
export const CommandsCatalogResponseSchema = Schema.Struct({
  canon: opt(Schema.Record(Str, Str)),
  categories: opt(Schema.Array(CommandCategorySchema)),
  pairs: Schema.Array(CommandPairSchema),
  skill_count: opt(Num),
  warning: opt(Str)
})
export type CommandsCatalogResponse = typeof CommandsCatalogResponseSchema.Type

const decodeStatus = Schema.decodeUnknownOption(SessionStatusResponseSchema)
const decodeTitle = Schema.decodeUnknownOption(SessionTitleResponseSchema)
const decodeSave = Schema.decodeUnknownOption(SessionSaveResponseSchema)
const decodeReloadEnv = Schema.decodeUnknownOption(ReloadEnvResponseSchema)
const decodeSkillsReload = Schema.decodeUnknownOption(SkillsReloadResponseSchema)
const decodeCommandsCatalog = Schema.decodeUnknownOption(CommandsCatalogResponseSchema)

function some<A>(value: Option.Option<A>): A | undefined {
  return Option.isSome(value) ? value.value : undefined
}

export const decodeSessionStatusResponse = (value: unknown): SessionStatusResponse | undefined =>
  some(decodeStatus(value))

export const decodeSessionTitleResponse = (value: unknown): SessionTitleResponse | undefined => some(decodeTitle(value))

export const decodeSessionSaveResponse = (value: unknown): SessionSaveResponse | undefined => some(decodeSave(value))

export const decodeReloadEnvResponse = (value: unknown): ReloadEnvResponse | undefined => some(decodeReloadEnv(value))

export const decodeSkillsReloadResponse = (value: unknown): SkillsReloadResponse | undefined =>
  some(decodeSkillsReload(value))

export const decodeCommandsCatalogResponse = (value: unknown): CommandsCatalogResponse | undefined =>
  some(decodeCommandsCatalog(value))
