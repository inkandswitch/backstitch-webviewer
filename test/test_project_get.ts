import path from "path";
import { getBranchFiles, getBranchFilesAsZip } from "../src/automerge_getter";
import fs from "fs";
async function testProjectGet() {
  let files = await getBranchFiles("to2i9YGkdhXy3Li4K7FoUSQ9Yzv");
  fs.mkdirSync("test_project", { recursive: true });
  for (const [filename, content] of files.entries()) {
    let file = filename.replace("res://", "");
    let basedir = path.dirname(file);
    fs.mkdirSync(`test_project/${basedir}`, { recursive: true });
    fs.writeFileSync(`test_project/${file}`, content);
  }
}

async function testProjectGetAsZip() {
  let buf = new Uint8Array(await getBranchFilesAsZip("to2i9YGkdhXy3Li4K7FoUSQ9Yzv"));
  fs.writeFileSync("test_project.zip", buf);
}

testProjectGet()
  .then(() => {
    testProjectGetAsZip()
      .then(() => {
        console.log("done");
      })
      .catch((error) => {
        console.error(error);
      });
  })
  .catch((error) => {
    console.error(error);
  });
