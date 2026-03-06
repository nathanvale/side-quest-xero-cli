#!/usr/bin/env python3
"""Parse PR comment JSON from stdin and output detailed summary."""
import json
import sys

data = json.load(sys.stdin)
for i, item in enumerate(data):
    n = item["node"]
    comment = n["comments"]["nodes"][0]
    author = comment["author"]["login"]
    body = comment["body"]

    # Extract the agent prompt if present
    prompt_start = body.find("```\nVerify each finding")
    if prompt_start == -1:
        prompt_start = body.find("```\nIn @")
    prompt_end = body.find("```\n\n</details>", prompt_start) if prompt_start != -1 else -1

    agent_prompt = ""
    if prompt_start != -1 and prompt_end != -1:
        agent_prompt = body[prompt_start+4:prompt_end].strip()

    # Extract summary line
    summary = ""
    for line in body.split("\n"):
        line = line.strip()
        if line.startswith("**") and line.endswith("**"):
            summary = line.strip("*").strip()
            break

    print(f"=== THREAD {i} ===")
    print(f"ID: {n['id']}")
    print(f"FILE: {n['path']}")
    print(f"LINE: {n.get('startLine', n['line'])}-{n['line']}")
    print(f"SUMMARY: {summary}")
    if agent_prompt:
        print(f"AGENT_PROMPT: {agent_prompt}")
    else:
        # Print first 300 chars of body as fallback
        print(f"BODY: {body[:300]}")
    print()

print(f"TOTAL: {len(data)}")
