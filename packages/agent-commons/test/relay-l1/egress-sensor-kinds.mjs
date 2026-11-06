// The egress-sensor record kinds that are not egress: the sensor's own start line, and dns.lookup of an
// IP literal (answered inside Node without any resolver call; server.listen on an address does this).
export const NOT_EGRESS = Object.freeze(["sensor.armed", "dns.lookup-literal"]);
