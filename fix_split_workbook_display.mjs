import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/59110/Documents/New project/outputs/比亚迪甩箱统计_拆分.xlsx";
const outputDir = "C:/Users/59110/Documents/New project/outputs";
const outputPath = path.join(outputDir, "比亚迪甩箱统计_拆分_修正显示.xlsx");

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Sheet1");
const usedRange = sheet.getUsedRange();
const rows = usedRange.values ?? [];

if (rows.length === 0) {
  throw new Error("Sheet1 is empty.");
}

const headers = rows[0];
const scacIndex = headers.findIndex((value) => String(value).trim() === "SCAC");
const traceNoIndex = headers.findIndex((value) => String(value).trim() === "TraceNo");
const ctnIndex = headers.findIndex((value) => String(value).trim() === "CtnNos");

if (scacIndex === -1 || traceNoIndex === -1 || ctnIndex === -1) {
  throw new Error("Could not find required columns: SCAC, TraceNo, CtnNos.");
}

const normalizedRows = rows.map((row, index) => {
  const nextRow = [...row];

  if (index > 0 && nextRow[traceNoIndex] != null && String(nextRow[traceNoIndex]).trim() !== "") {
    nextRow[traceNoIndex] = String(nextRow[traceNoIndex]).trim();
  }

  if (index > 0 && nextRow[scacIndex] != null) {
    nextRow[scacIndex] = String(nextRow[scacIndex]).trim();
  }

  if (index > 0 && nextRow[ctnIndex] != null) {
    nextRow[ctnIndex] = String(nextRow[ctnIndex]).trim();
  }

  return nextRow;
});

usedRange.values = normalizedRows;

const rowCount = normalizedRows.length;
sheet.getRange(`A2:A${rowCount}`).format.numberFormat = "@";
sheet.getRange(`B2:B${rowCount}`).format.numberFormat = "@";
sheet.getRange(`C2:C${rowCount}`).format.numberFormat = "@";

sheet.getRange(`A1:C${rowCount}`).format.wrapText = false;
sheet.getRange("A:A").format.columnWidthPx = 90;
sheet.getRange("B:B").format.columnWidthPx = 180;
sheet.getRange("C:C").format.columnWidthPx = 140;

await fs.mkdir(outputDir, { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

console.log(
  JSON.stringify(
    {
      outputPath,
      rowCount,
    },
    null,
    2,
  ),
);
