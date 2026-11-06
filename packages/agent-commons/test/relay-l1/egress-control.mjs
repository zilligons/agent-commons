// L1 acceptance harness (N25): the control build. Loaded AFTER the egress sensor, it makes one outbound
// connect that the relay itself never makes. The target is a closed LOOPBACK port, so no packet ever
// leaves the host or the container; the sensor must still record the attempt, so a sensor that records
// nothing cannot pass for "no egress". (The network cut itself is proved separately, from the
// container's attachments and route table, never by trying to reach the internet.)
import { connect } from "node:net";
const s = connect({ host: "127.0.0.1", port: 9 });
s.on("error", () => {});
s.setTimeout(1000, () => s.destroy());
