"""Turns a good fixture bundle into a hostile one, with the entries from the security review of
the release script (its mk.py). The good entries are kept, so the app would still be healthy.
usage: python3 hostile-bundle.py <good.tgz> <out.tgz> <kind>
kinds:
  dev     a character device, a block device and a fifo
  suid    setuid, setgid and world-writable files, and a world-writable setuid directory
  revsym  REVISION as a symlink to /tmp/plant/victim
"""
import io
import sys
import tarfile

good, out, kind = sys.argv[1:4]


def add(t, name, typ, data=b"", mode=0o644, link=""):
    ti = tarfile.TarInfo(name)
    ti.type = typ
    ti.mode = mode
    ti.linkname = link
    if typ == tarfile.CHRTYPE:
        ti.devmajor, ti.devminor = 1, 1
    if typ == tarfile.BLKTYPE:
        ti.devmajor, ti.devminor = 8, 0
    ti.size = len(data) if typ == tarfile.REGTYPE else 0
    t.addfile(ti, io.BytesIO(data) if typ == tarfile.REGTYPE else None)


R = tarfile.REGTYPE
entries = {
    "dev": [("mem", tarfile.CHRTYPE, b"", 0o666), ("disk", tarfile.BLKTYPE, b"", 0o666),
            ("fifo", tarfile.FIFOTYPE, b"", 0o666)],
    "suid": [("suid", R, b"#!/bin/sh\n", 0o4755), ("sgid", R, b"#!/bin/sh\n", 0o2755),
             ("ww", R, b"x", 0o777), ("pub", tarfile.DIRTYPE, b"", 0o1777 | 0o4000)],
    "revsym": [("REVISION", tarfile.SYMTYPE, b"", 0o777, "/tmp/plant/victim")],
}[kind]

with tarfile.open(good, "r:gz") as src, tarfile.open(out, "w:gz") as dst:
    for m in src.getmembers():
        dst.addfile(m, src.extractfile(m) if m.isfile() else None)
    for e in entries:
        add(dst, *e)
