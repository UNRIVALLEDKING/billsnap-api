import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openApiDocument } from "../src/http/openapi";

const contractDir = resolve(import.meta.dir, "../../contract");
mkdirSync(contractDir, { recursive: true });

const mathTestVectors = [
  { description: "half-up rounding 1.005", input: "1.005", expected: "1.01" },
  { description: "half-up rounding 2.675", input: "2.675", expected: "2.68" },
  { description: "line amount 3 * 0.1", qty: "3", rate: "0.1", expected: "0.30" },
  { description: "line amount 2.5 * 12.3456", qty: "2.5", rate: "12.3456", expected: "30.86" },
  {
    description: "sum of ten 0.1s",
    values: ["0.1", "0.1", "0.1", "0.1", "0.1", "0.1", "0.1", "0.1", "0.1", "0.1"],
    expected: "1.00",
  },
];

writeFileSync(resolve(contractDir, "openapi.json"), JSON.stringify(openApiDocument, null, 2));
writeFileSync(resolve(contractDir, "math_vectors.json"), JSON.stringify(mathTestVectors, null, 2));
console.log("Contract generated successfully at", contractDir);
