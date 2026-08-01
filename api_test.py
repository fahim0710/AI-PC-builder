import os
import sys
from huggingface_hub import InferenceClient
from huggingface_hub.errors import HfHubHTTPError

# Initialize the official client with your token
# Make sure to replace this with your actual token!
HF_TOKEN = os.environ.get("HF_TOKEN")
if not HF_TOKEN:
    raise RuntimeError("Set HF_TOKEN in your environment before running this test.")

client = InferenceClient(
    model="facebook/bart-large-cnn", 
    token=HF_TOKEN
)

def test_api():
    print("Testing Hugging Face connection via official SDK...")
    try:
        # Call the text summarization endpoint
        response = client.summarization(
            "The quick brown fox jumps over the lazy dog. This is just a test sentence to check connectivity."
        )
        
        print("\n🟢 SUCCESS! Your API call is working perfectly.")
        print("Response:", response)
        
    except HfHubHTTPError as e:
        print(f"\n🔴 FAILED: API error occurred.")
        print(f"Status Code: {e.response.status_code if e.response else 'Unknown'}")
        print(f"Details: {e}")
    except Exception as e:
        print(f"\n❌ OTHER ERROR: {e}")

if __name__ == "__main__":
    test_api()
