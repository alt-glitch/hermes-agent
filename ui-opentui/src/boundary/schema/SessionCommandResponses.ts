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
export const ReloadMcpResponseSchema = Schema.Struct({
  message: opt(Str),
  status: Schema.Literals(['confirm_required', 'reloaded'])
})
export type ReloadMcpResponse = typeof ReloadMcpResponseSchema.Type

export const ConfigValueResponseSchema = Schema.Struct({ value: Str })
export type ConfigValueResponse = typeof ConfigValueResponseSchema.Type

export const ModelSwitchResponseSchema = Schema.Struct({
  confirm_message: opt(Str),
  confirm_required: opt(Schema.Boolean),
  value: opt(Str),
  warning: opt(Str)
})
export type ModelSwitchResponse = typeof ModelSwitchResponseSchema.Type

export const ConfigFullResponseSchema = Schema.Struct({
  config: Schema.Record(Str, Schema.Unknown)
})
export type ConfigFullResponse = typeof ConfigFullResponseSchema.Type

export const ConfigMtimeResponseSchema = Schema.Struct({ mtime: Num })
export type ConfigMtimeResponse = typeof ConfigMtimeResponseSchema.Type

export const SessionSteerResponseSchema = Schema.Struct({
  status: Schema.Literals(['queued', 'rejected']),
  text: opt(Str)
})
export type SessionSteerResponse = typeof SessionSteerResponseSchema.Type
export type SessionSteerDisposition = 'accepted' | 'rejected' | 'uncertain'

export const SessionUndoResponseSchema = Schema.Struct({ removed: Num, target_text: opt(Str) })
export type SessionUndoResponse = typeof SessionUndoResponseSchema.Type

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
const decodeReloadMcp = Schema.decodeUnknownOption(ReloadMcpResponseSchema)
const decodeConfigValue = Schema.decodeUnknownOption(ConfigValueResponseSchema)
const decodeModelSwitch = Schema.decodeUnknownOption(ModelSwitchResponseSchema)
const decodeConfigFull = Schema.decodeUnknownOption(ConfigFullResponseSchema)
const decodeConfigMtime = Schema.decodeUnknownOption(ConfigMtimeResponseSchema)
const decodeSessionSteer = Schema.decodeUnknownOption(SessionSteerResponseSchema)
const decodeSessionUndo = Schema.decodeUnknownOption(SessionUndoResponseSchema)
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
export const decodeReloadMcpResponse = (value: unknown): ReloadMcpResponse | undefined => some(decodeReloadMcp(value))

export const decodeConfigValueResponse = (value: unknown): ConfigValueResponse | undefined =>
  some(decodeConfigValue(value))
export const decodeModelSwitchResponse = (value: unknown): ModelSwitchResponse | undefined =>
  some(decodeModelSwitch(value))

export const decodeConfigFullResponse = (value: unknown): ConfigFullResponse | undefined =>
  some(decodeConfigFull(value))

export const decodeConfigMtimeResponse = (value: unknown): ConfigMtimeResponse | undefined =>
  some(decodeConfigMtime(value))

export const decodeSessionSteerResponse = (value: unknown): SessionSteerResponse | undefined =>
  some(decodeSessionSteer(value))

/** A documented `rejected` response proves non-admission. Malformed or
 * version-skewed successful responses prove nothing and therefore stay
 * ambiguous; treating them as rejection would permit an automatic duplicate. */
export const classifySessionSteerResponse = (value: unknown): SessionSteerDisposition => {
  const decoded = decodeSessionSteerResponse(value)
  if (!decoded) return 'uncertain'
  return decoded.status === 'queued' ? 'accepted' : 'rejected'
}

export const decodeSessionUndoResponse = (value: unknown): SessionUndoResponse | undefined =>
  some(decodeSessionUndo(value))

export const decodeSkillsReloadResponse = (value: unknown): SkillsReloadResponse | undefined =>
  some(decodeSkillsReload(value))

export const decodeCommandsCatalogResponse = (value: unknown): CommandsCatalogResponse | undefined =>
  some(decodeCommandsCatalog(value))
