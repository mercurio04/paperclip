/**
 * Typed OpenCode permission bridge (TAX-452): map a card decision to the only
 * resolution shape the server accepts for `paperclip.runtime_request.permission.v1`
 * and translate the server's refusal codes into something a human can act on.
 */
import { ApiError } from "@/api/client";
import type { RuntimeRequestResolution } from "@/api/heartbeats";
import type {
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";

export function permissionDecisionResolution(
  item: TaskChatRuntimeRequestItem,
  decision: TaskChatRuntimeRequestDecision,
): Extract<RuntimeRequestResolution, { action: "permission_decision" }> {
  const contract = item.permissionContract;
  if (!contract) {
    throw new Error(
      "This permission contract is invalid; it cannot be decided from Paperclip.",
    );
  }
  if (decision.action !== "permission_decision") {
    throw new Error(
      "This permission only accepts \"Allow once\" or \"Reject\".",
    );
  }
  if (decision.decision !== "once" && decision.decision !== "reject") {
    throw new Error("Unsupported permission decision.");
  }
  if (!contract.decisions.includes(decision.decision)) {
    throw new Error("This decision is not offered for this permission.");
  }
  if (decision.contractSha256 !== contract.contractSha256) {
    throw new Error(
      "The permission contract changed since it was shown; reload before deciding.",
    );
  }
  return {
    action: "permission_decision",
    decision: decision.decision,
    contractSha256: contract.contractSha256,
  };
}

export function permissionDecisionError(cause: unknown): Error {
  if (cause instanceof ApiError) {
    const detail = cause.message ? ` (${cause.message})` : "";
    if (cause.status === 409) {
      return new Error(
        `This permission was already decided or its contract no longer matches${detail}.`,
      );
    }
    if (cause.status === 502) {
      return new Error(
        `Delivery of the decision to the runtime could not be confirmed; it will not be retried automatically${detail}.`,
      );
    }
    if (cause.status === 400) {
      return new Error(`The server rejected the permission decision${detail}.`);
    }
  }
  return cause instanceof Error
    ? cause
    : new Error("No se pudo resolver el permiso.");
}
