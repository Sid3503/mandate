import os
import sys
from dotenv import load_dotenv
from openai import OpenAI

# Load .env file from current directory
load_dotenv()

api_key = os.getenv("BEDROCK_API_KEY")
if not api_key:
    print("Error: BEDROCK_API_KEY environment variable not found.", file=sys.stderr)
    print("Please set BEDROCK_API_KEY in your environment or in .env", file=sys.stderr)
    sys.exit(1)

region = os.getenv("AWS_REGION") or os.getenv("BEDROCK_REGION") or "us-east-1"
model = os.getenv("BEDROCK_MODEL") or "amazon.nova-lite-v1:0"

if len(sys.argv) > 1:
    model = sys.argv[1]
if len(sys.argv) > 2:
    region = sys.argv[2]

base_url = f"https://bedrock-runtime.{region}.amazonaws.com/openai/v1"

print(f"Testing Amazon Bedrock OpenAI-compatible endpoint:")
print(f"  Region:   {region}")
print(f"  Base URL: {base_url}")
print(f"  Model:    {model}")
print("-" * 50)

client = OpenAI(
    api_key=api_key,
    base_url=base_url,
)

try:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Say hello and give a one-sentence tip on using Amazon Bedrock."},
        ],
        temperature=0.2,
    )
    print("Response received successfully:\n")
    print(response.choices[0].message.content)
except Exception as e:
    print(f"\nError calling Bedrock endpoint: {e}", file=sys.stderr)
    sys.exit(1)
