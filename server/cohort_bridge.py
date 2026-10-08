"""Preview-only model bridge. No provider downgrade or simulated response."""
import asyncio
import json
import sys

ERROR_MESSAGES = {
    "MODEL_UNAVAILABLE": "This exact model is not available through the preview model transport. Computer worker availability is a separate capability.",
    "ACCESS_DENIED": "The preview transport denied access to this model. Reauthorization does not automatically change model entitlement.",
    "AUTHENTICATION": "The preview model transport could not authenticate. Check the server credential injection.",
    "RATE_LIMIT": "The provider or transport rate limit was reached.",
    "TIMEOUT": "The model request exceeded its time budget.",
    "PROVIDER_UNAVAILABLE": "The provider or transport is temporarily unavailable.",
    "UNSUPPORTED_PARAMETERS": "The transport rejected a model request parameter.",
    "EMPTY_RESPONSE": "The provider returned no visible text.",
    "TRANSPORT_ERROR": "The model transport failed; no agent response was fabricated.",
}

def describe_error(error):
    """Classify private provider details without returning headers, URLs or secrets."""
    status = ""
    code = getattr(error, "code", None)
    try:
        value = code() if callable(code) else code
        status = getattr(value, "name", "") or str(value or "")
    except Exception:
        pass
    if status not in {
        "OK", "CANCELLED", "UNKNOWN", "INVALID_ARGUMENT", "DEADLINE_EXCEEDED",
        "NOT_FOUND", "ALREADY_EXISTS", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED",
        "FAILED_PRECONDITION", "ABORTED", "OUT_OF_RANGE", "UNIMPLEMENTED",
        "INTERNAL", "UNAVAILABLE", "DATA_LOSS", "UNAUTHENTICATED",
    }:
        status = ""
    categories = []
    for info in getattr(error, "debug_info", []) or []:
        kind = getattr(info, "error_type", "")
        if isinstance(kind, str) and kind.replace("_", "").isalnum() and len(kind) <= 80:
            categories.append(kind)
    private_detail = ""
    details = getattr(error, "details", None)
    try:
        private_detail = details() if callable(details) else str(details or error)
    except Exception:
        pass
    diagnostic = " ".join([type(error).__name__, status, *categories, str(private_detail)]).lower()
    if any(s in diagnostic for s in ["not_found", "unknown model", "unsupported model", "model not found", "model is not available", "model_unavailable", "modelnotfound"]):
        reason = "MODEL_UNAVAILABLE"
    elif any(s in diagnostic for s in ["permission_denied", "accessdenied", "not enabled", "not allowed"]):
        reason = "ACCESS_DENIED"
    elif any(s in diagnostic for s in ["unauthenticated", "authenticationerror", "invalid api key"]):
        reason = "AUTHENTICATION"
    elif any(s in diagnostic for s in ["resource_exhausted", "ratelimit", "rate limit"]):
        reason = "RATE_LIMIT"
    elif any(s in diagnostic for s in ["deadline_exceeded", "timeouterror", "timed out"]):
        reason = "TIMEOUT"
    elif any(s in diagnostic for s in ["invalid_argument", "unsupported parameter", "invalid parameter"]):
        reason = "UNSUPPORTED_PARAMETERS"
    elif any(s in diagnostic for s in ["unavailable", "serviceerror", "servererror"]):
        reason = "PROVIDER_UNAVAILABLE"
    elif "empty provider response" in diagnostic:
        reason = "EMPTY_RESPONSE"
    else:
        reason = "TRANSPORT_ERROR"
    return {
        "error": type(error).__name__,
        "code": reason,
        "message": ERROR_MESSAGES[reason],
        "transportStatus": status or None,
        "retryable": reason in ["RATE_LIMIT", "TIMEOUT", "PROVIDER_UNAVAILABLE"],
    }

async def main(request):
    # Keep the public error-classifier tests independent of the private preview SDK.
    from pplx.python.sdks.llm_api import (
        Client, Conversation, Identity, LLMAPIClient, SamplingParams,
        TextBlock, ThinkingParams, ReasoningEffort,
    )
    conversation = Conversation()
    conversation.add_user([TextBlock(text=request["prompt"])])
    result = await asyncio.wait_for(
        LLMAPIClient(grpc_max_retries=0).messages.create(
            model=request["model"], convo=conversation,
            identity=Identity(client=Client.ASI, use_case="webserver_agent_commons_cohort"),
            sampling_params=SamplingParams(max_tokens=1800),
            thinking_params=ThinkingParams(reasoning_effort=ReasoningEffort.LOW),
        ), timeout=75,
    )
    if not result.text:
        raise RuntimeError("Empty provider response")
    return {"text":result.text}

if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main(json.load(sys.stdin)))))
    except Exception as error:
        print(json.dumps(describe_error(error)))
