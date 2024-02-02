import fs from "fs/promises";
import { node as tfnode } from "@tensorflow/tfjs-node";

const model = await tfnode.loadSavedModel("tflite_models/nsfw_detection");

async function classifyImageFile(model, softmax, path) {
  const imageBuffer = await fs.readFile(path);
  const tensor = tfnode
    .decodeImage(imageBuffer)
    .resizeBilinear([224, 224])
    .div(255)
    .expandDims(0);
  const output = model.predict(tensor).unstack()[0];
  const predictions = softmax ? output.softmax() : output;
  const { values, indices } = predictions.topk(5);
  values.print();
  indices.print();
}

classifyImageFile(model, false, "public/images/users/rat.jpg");
