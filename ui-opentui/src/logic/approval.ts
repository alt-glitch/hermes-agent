/** Approval choices shared by the decoded prompt, view, and response guard. */
export type ApprovalChoice = 'once' | 'session' | 'always' | 'deny'

const WITH_PERMANENT = ['once', 'session', 'always', 'deny'] as const
const WITHOUT_PERMANENT = ['once', 'session', 'deny'] as const

/** The choices the user may see for this request. */
export function approvalChoices(allowPermanent: boolean): readonly ApprovalChoice[] {
  return allowPermanent ? WITH_PERMANENT : WITHOUT_PERMANENT
}

/**
 * Fail closed at the RPC seam. The view already hides `always` when the
 * gateway sends `allow_permanent=false`, but this second check prevents a
 * stale/native selection callback or future UI regression from emitting a
 * permanence scope the backend explicitly prohibited.
 */
export function secureApprovalChoice(choice: unknown, allowPermanent: boolean): ApprovalChoice {
  if (choice !== 'once' && choice !== 'session' && choice !== 'always' && choice !== 'deny') return 'deny'
  return choice === 'always' && !allowPermanent ? 'deny' : choice
}
