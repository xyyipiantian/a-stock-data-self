import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/59110/Downloads/比亚迪甩箱统计.xlsx";
const outputDir = "C:/Users/59110/Documents/New project/outputs";
const outputPath = path.join(outputDir, "比亚迪甩箱统计_拆分.xlsx");

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Sheet1");
const usedRange = sheet.getUsedRange();
const rows = usedRange.values ?? [];

if (rows.length === 0) {
  throw new Error("Sheet1 is empty.");
}

const headers = rows[0];
const ctnIndex = headers.findIndex((value) => String(value).trim() === "CtnNos");
const scacIndex = headers.findIndex((value) => String(value).trim() === "SCAC");
const traceNoIndex = headers.findIndex((value) => String(value).trim() === "TraceNo");

if (ctnIndex === -1 || scacIndex === -1 || traceNoIndex === -1) {
  throw new Error("Could not find required columns: SCAC, TraceNo, CtnNos.");
}

const expandedRows = [headers];

for (let i = 1; i < rows.length; i += 1) {
  const row = rows[i] ?? [];
  const ctnValue = row[ctnIndex];

  if (ctnValue == null || String(ctnValue).trim() === "") {
    expandedRows.push(row);
    continue;
  }

  const ctnNos = String(ctnValue)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (ctnNos.length <= 1) {
    expandedRows.push(row);
    continue;
  }

  for (const ctnNo of ctnNos) {
    const nextRow = [...row];
    nextRow[ctnIndex] = ctnNo;
    expandedRows.push(nextRow);
  }
}

usedRange.clear({ applyTo: "all" });
const lastColumnLetter = String.fromCharCode(65 + headers.length - 1);
sheet.getRange(`A1:${lastColumnLetter}${expandedRows.length}`).values = expandedRows;

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(
  JSON.stringify(
    {
      inputRows: rows.length,
      outputRows: expandedRows.length,
      outputPath,
    },
    null,
    2,
  ),
);
