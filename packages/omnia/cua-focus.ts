import { LinuxHostDriver } from "./src/daemon/linux"
import { createHostDriver } from "./src/daemon/host-driver"
const driver = createHostDriver(new LinuxHostDriver())
const found = await driver.find({ query: "LibreOffice Writer", limit: 5 })
const match = (found.matches ?? found.results ?? [])[0]
console.log("match:", match?.element?.id, match?.element?.role, match?.element?.name)
if (match?.element?.id !== undefined) {
  const r = await driver.execute({ type: "focus", target: { kind: "element", elementId: match.element.id } })
  console.log("focus:", r.success, (r.message ?? "").slice(0, 100), r.verification?.status)
}
process.exit(0)
