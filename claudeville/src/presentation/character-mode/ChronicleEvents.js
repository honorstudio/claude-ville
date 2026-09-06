// Git commit event helpers used by Chronicle subsystems.
// Extracted from the former ChronicleManifests module so the visual
// "manifest" rendering could be removed without losing event collection.

export {
    collectCommitEvents,
    commitMessageFromCommand,
} from '../shared/GitEventIdentity.js';

export {
    createVerifiedOutcome,
    verifiedOutcomeFromGitEvent,
    verifiedOutcomeIsLive,
    verifiedOutcomeKey,
    VERIFIED_OUTCOME_EVENT,
    VERIFIED_OUTCOME_KINDS,
    VERIFIED_OUTCOME_LIVE_MS,
} from '../../domain/services/VerifiedOutcome.js';
