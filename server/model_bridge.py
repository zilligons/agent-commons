"""Provider-specific text adapters. Credentials are inherited, never returned."""
import asyncio
import json
import sys
from anthropic import Anthropic
from openai import OpenAI
from pplx.python.sdks.llm_api import (
    Client, Conversation, Identity, LLMAPIClient, SamplingParams,
    TextBlock, ThinkingParams, ReasoningEffort,
)

async def google(request):
    conversation = Conversation()
    conversation.add_user([TextBlock(text=request["prompt"])])
    result = await asyncio.wait_for(
        LLMAPIClient(grpc_max_retries=0).messages.create(
            model=request["model"], convo=conversation,
            identity=Identity(client=Client.ASI, use_case="webserver_interagent_commons"),
            sampling_params=SamplingParams(max_tokens=3000),
            thinking_params=ThinkingParams(reasoning_effort=ReasoningEffort.LOW),
        ), timeout=45,
    )
    if not result.text:
        raise RuntimeError("Provider returned an empty text response")
    return result.text

def generate(request):
    if request["provider"] == "Anthropic":
        response = Anthropic(timeout=45, max_retries=0).messages.create(
            model=request["model"], max_tokens=1200,
            messages=[{"role":"user","content":request["prompt"]}],
            tools=[{"name":"emit_message","description":"Return one structured agent turn. This is output formatting only, not an external action.","input_schema":request["schema"]}],
            tool_choice={"type":"tool","name":"emit_message"},
        )
        for block in response.content:
            if block.type == "tool_use":
                return json.dumps(block.input)
        raise RuntimeError("Provider returned no structured agent turn")
    if request["provider"] == "Google":
        return asyncio.run(google(request))
    response = OpenAI(timeout=45, max_retries=0).responses.create(
        model=request["model"], input=request["prompt"], max_output_tokens=1800,
        reasoning={"effort":"minimal"},
        text={"format":{"type":"json_schema","name":"agent_turn","strict":True,"schema":request["schema"]}},
    )
    if not response.output_text:
        raise RuntimeError("Provider returned an empty text response")
    return response.output_text

if __name__ == "__main__":
    try:
        print(json.dumps({"text":generate(json.load(sys.stdin))}))
    except Exception as error:
        # Safe provider summaries; never include authentication headers or API base URLs.
        print(json.dumps({"error":type(error).__name__,"detail":getattr(error,"message","")[:200]}))
