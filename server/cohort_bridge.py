"""Preview-only model bridge. No provider downgrade or simulated response."""
import asyncio
import json
import sys
from pplx.python.sdks.llm_api import (
    Client, Conversation, Identity, LLMAPIClient, SamplingParams,
    TextBlock, ThinkingParams, ReasoningEffort,
)

async def main(request):
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
        # Do not return provider headers, endpoints or raw authentication errors.
        print(json.dumps({"error":type(error).__name__}))
