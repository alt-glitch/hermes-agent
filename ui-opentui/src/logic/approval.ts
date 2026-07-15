/** Approval choices shared by the decoded prompt, view, and response guard. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

/**
 * The existing overlay coordinator passes this value through its
 * `allowPermanent` slot. A boolean is the legacy policy for gateways that omit
 * additive authority fields; an array is the exact server-authoritative set.
 */
export type ApprovalChoicePolicy = boolean | readonly ApprovalChoice[]

const WITH_PERMANENT = ['once', 'session', 'always', 'deny'] as const
const WITHOUT_PERMANENT = ['once', 'session', 'deny'] as const
const SMART_DENIED = ['once', 'deny'] as const

function isApprovalChoice(value: string): value is ApprovalChoice {
  return value === 'once' || value === 'session' || value === 'always' || value === 'deny'
}

/** Resolve additive gateway authority while preserving older gateway behavior. */
export function approvalPolicy(input: {
  readonly allowPermanent?: boolean
  readonly choices?: readonly string[]
  readonly smartDenied?: boolean
}): ApprovalChoicePolicy {
  if (input.choices !== undefined) {
    const choices = input.choices.filter(isApprovalChoice)
    return input.smartDenied === true ? choices.filter(choice => choice === 'once' || choice === 'deny') : choices
  }
  if (input.smartDenied === true) return SMART_DENIED
  return input.allowPermanent !== false
}

/** The choices the user may see for this request. */
export function approvalChoices(policy: ApprovalChoicePolicy): readonly ApprovalChoice[] {
  return typeof policy === 'boolean' ? (policy ? WITH_PERMANENT : WITHOUT_PERMANENT) : policy
}

/**
 * Fail closed at the RPC seam. The view already hides `always` when the
 * gateway sends `allow_permanent=false`, but this second check prevents a
 * stale/native selection callback or future UI regression from emitting a
 * permanence scope the backend explicitly prohibited.
 */
export function secureApprovalChoice(choice: unknown, policy: ApprovalChoicePolicy): ApprovalChoice {
  if (choice !== 'once' && choice !== 'session' && choice !== 'always' && choice !== 'deny') return 'deny'
  return approvalChoices(policy).includes(choice) ? choice : 'deny'
}
