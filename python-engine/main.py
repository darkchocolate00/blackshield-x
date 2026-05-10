import sys, json

def process(data):
    url = data.get("url","")
    risk = "low"
    if "phishing" in url:
        risk = "high"
    return {"risk": risk, "url": url}

for line in sys.stdin:
    try:
        data = json.loads(line.strip())
        print(json.dumps(process(data)), flush=True)
    except:
        pass