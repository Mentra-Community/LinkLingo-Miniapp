import {dump, label, screenshot} from "./ui"
const nodes = await dump()
for (const n of nodes) {
  const l = label(n)
  if (l || n.clickable)
    console.log(
      `${n.clickable ? "[tap]" : "     "} (${n.cx},${n.cy}) ${n.cls.split(".").pop()} ${JSON.stringify(l)}${n.enabled ? "" : " (disabled)"}`,
    )
}
if (process.argv[2]) console.log("shot:", await screenshot(process.argv[2]))
