import { serializeGodotScene } from "../src/godot_serializer";

function test() {
  const fs = require("fs");
  const structured_content = JSON.parse(fs.readFileSync("test/test.json", "utf8"));
  const serialized = serializeGodotScene(structured_content);
  // console.log(serialized);
  fs.writeFileSync("test_files/test.tscn", serialized);
}

test();
