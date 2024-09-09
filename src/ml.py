from os import getenv
from dotenv import load_dotenv
from flask import Flask, jsonify
from opennsfw2 import predict_image

MODE = getenv('NODE_ENV')
load_dotenv("src/config/.env")
load_dotenv(f"src/config/.env.{MODE}", override=True)

ML_HOST = getenv('ML_HOST')
ML_PORT = getenv('ML_PORT')
nsfwThreshold = 0.5

def isNSFW(path: str) -> bool:
    return predict_image(path) > nsfwThreshold

app = Flask(__name__)


@app.route('/<path:path>')
def predict(path: str):
    print(f"Requested NSFW detection at {path}")
    try:
        return jsonify(isNSFW(f"./public/images/{path}"))
    except:
        return "File not found", 404


if __name__ == "__main__":
    print(f"Started ML server on port {ML_PORT}")
    from waitress import serve
    serve(app, host = ML_HOST, port = ML_PORT)