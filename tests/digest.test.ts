import { describe, expect, it } from "vitest";
import { computeDirectoryDigest } from "../src/github/commandFiles";

describe("computeDirectoryDigest", () => {
    it("matches the Python reference implementation bit-for-bit", () => {
        // hashlib vector: sha256 over entries sorted by path, "path\0sha\n" each.
        // python -c "import hashlib; entries=[('commands/wifi.json','abc123'),
        //   ('commands/airlink.json','def456'),('commands/zzz.json','0f9e8d')];
        //   h=hashlib.sha256(); [h.update(p.encode()+b'\0'+s.encode()+b'\n')
        //   for p,s in sorted(entries)]; print(h.hexdigest())"
        const digest = computeDirectoryDigest([
            { path: "commands/wifi.json", sha: "abc123" },
            { path: "commands/airlink.json", sha: "def456" },
            { path: "commands/zzz.json", sha: "0f9e8d" },
        ]);
        expect(digest).toBe("7bcd262a219e520b162d41ff5a9eb383df99bf04787451df16fac284575e74f2");
    });

    it("is order-independent (input) but content-sensitive", () => {
        const a = computeDirectoryDigest([
            { path: "a.json", sha: "1" },
            { path: "b.json", sha: "2" },
        ]);
        const b = computeDirectoryDigest([
            { path: "b.json", sha: "2" },
            { path: "a.json", sha: "1" },
        ]);
        expect(a).toBe(b);
        const c = computeDirectoryDigest([
            { path: "a.json", sha: "1" },
            { path: "b.json", sha: "CHANGED" },
        ]);
        expect(c).not.toBe(a);
    });
});
