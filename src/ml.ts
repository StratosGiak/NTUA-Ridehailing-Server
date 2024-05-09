import fs from "fs/promises";
import {
  node as tfnode,
  tidy as tftidy,
  dispose as tfdispose,
  enableProdMode,
  loadLayersModel,
  loadGraphModel,
  GraphModel,
  Tensor,
} from "@tensorflow/tfjs-node";
import { TFSavedModel } from "@tensorflow/tfjs-node/dist/saved_model.js";
import { loggerMain } from "./logger.js";
//enableProdMode();

const modelNSFW = await tfnode.loadSavedModel("./tflite_models/nsfw_detection");

async function classifyImageFile(
  model: TFSavedModel,
  path: string,
  softmax: boolean
) {
  const imageBuffer = await fs.readFile(path);
  const predictions = tftidy(() => {
    const tensor = tfnode
      .decodeImage(imageBuffer)
      .resizeBilinear([224, 224])
      .div(255)
      .expandDims(0);
    const output = model.predict(tensor);
    if (!(output instanceof Tensor)) throw new Error("Tensor error");
    const predictions = softmax ? output.softmax() : output;
    return predictions;
  });
  const predictionArray = predictions.data();
  tfdispose(predictions);
  return predictionArray;
}

export async function isNSFW(path: string) {
  return classifyImageFile(modelNSFW, path, false)
    .then((values) => {
      return values[0] + values[2] < 0.1;
    })
    .catch((error) => {
      loggerMain.warn(error);
    });
}
