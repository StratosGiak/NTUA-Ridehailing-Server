import fs from "fs/promises";
import {
  node as tfnode,
  tidy as tftidy,
  dispose as tfdispose,
  enableProdMode,
  loadLayersModel,
  loadGraphModel,
} from "@tensorflow/tfjs-node";
enableProdMode();

const modelNSFW = await tfnode.loadSavedModel("./tflite_models/nsfw_detection");

async function classifyImageFile(model, softmax, path) {
  const imageBuffer = await fs.readFile(path);
  const predictions = tftidy(() => {
    const tensor = tfnode
      .decodeImage(imageBuffer)
      .resizeBilinear([224, 224])
      .div(255)
      .expandDims(0);
    const output = model.predict(tensor).unstack()[0];
    const predictions = softmax ? output.softmax() : output;
    return predictions;
  });
  const predictionArray = predictions.data();
  tfdispose(predictions);
  return predictionArray;
}

export async function isNSFW(path) {
  return classifyImageFile(modelNSFW, false, path)
    .then((values) => {
      console.log(values);
      return values[0] + values[2] < 0.1;
    })
    .catch((error) => {
      console.log(error);
    });
}
