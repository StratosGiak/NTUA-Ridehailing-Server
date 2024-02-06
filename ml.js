import fs from "fs/promises";
import { node as tfnode } from "@tensorflow/tfjs-node";

const modelNSFW = await tfnode.loadSavedModel("tflite_models/nsfw_detection");
const modelHumanCar = await tfnode.loadSavedModel("tflite_models/mobilenetv3");

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
  tensor.dispose();
  return values.data();
}

classifyImageFile(modelHumanCar, true, "public/images/users/panda.jpg");
