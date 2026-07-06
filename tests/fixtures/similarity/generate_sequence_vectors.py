#!/usr/bin/env python3
"""Golden-vector generator for the TS SequenceMatcher port in
src/features/crosspost/similarity.ts.

Emits sequence_ratio_vectors.json next to this file: (a, b, ratio) triples
computed by Python's difflib.SequenceMatcher (autojunk=True, the default),
which is the authoritative reference the port must match bit-for-bit.
tests/similarity.test.ts asserts exact float equality against these.

Regenerate (e.g. against a new CPython to catch difflib changes) with:
    python tests/fixtures/similarity/generate_sequence_vectors.py
"""

import difflib
import json
import pathlib
import random
import sys

cases = []


def add(name: str, a: str, b: str) -> None:
    ratio = difflib.SequenceMatcher(None, a, b).ratio()
    cases.append({"name": name, "a": a, "b": b, "ratio": ratio})


# --- degenerate inputs -------------------------------------------------------
add("empty-both", "", "")
add("empty-a", "", "quest3 keeps disconnecting")
add("empty-b", "quest3 keeps disconnecting", "")
add("identical", "virtualdesktop stutters on 5ghz", "virtualdesktop stutters on 5ghz")
add("classic", "abcd", "bcde")
add("single-char", "a", "b")

# --- typical normalized crosspost pairs (lowercase alnum + spaces) -----------
NEAR_A = "my quest3 keeps disconnecting from virtualdesktop every few minutes any ideas"
NEAR_B = "quest3 keeps disconnecting from virtualdesktop every couple of minutes help"
add("near-dup", NEAR_A, NEAR_B)
add("near-dup-rev", NEAR_B, NEAR_A)  # ratio() is NOT symmetric; lock both directions

add(
    "unrelated",
    "how do i enable passthrough in the quest3 home environment",
    "virtualdesktop shows a black screen when steamvr launches",
)

# --- autojunk territory: len(b) >= 200 makes popular chars junk in b2j -------
LONG_A = (
    "having constant stuttering and packet loss when streaming pcvr over "
    "virtualdesktop on quest3 my router is right next to me on a dedicated "
    "5ghz network nothing else connected tried lowering bitrate and changing "
    "codec still the same problem every session"
)
LONG_B = (
    "having constant stutter and packet loss when streaming pcvr through "
    "virtualdesktop on quest3 the router is right next to me on a dedicated "
    "5ghz network nothing else is connected i tried lowering the bitrate and "
    "changing codec but still the same problem every session"
)
assert len(LONG_A) >= 200 and len(LONG_B) >= 200
add("long-near-dup", LONG_A, LONG_B)
add("long-near-dup-rev", LONG_B, LONG_A)

# Exactly at / just under the autojunk length threshold (fires only at >= 200).
B200 = "word " * 40  # 200 chars: ' ' and each letter appear enough to be popular
B199 = B200[:199]
A_BOUND = "wxrd " * 40
assert len(B200) == 200 and len(B199) == 199 and len(A_BOUND) == 200
add("autojunk-at-200", A_BOUND, B200)
add("autojunk-under-200", A_BOUND, B199)

# Degenerate autojunk: every char of b is popular, so b2j ends up empty and the
# DP loop finds nothing — but find_longest_match's extension loops still match
# the 240-char common prefix from (alo, blo), giving 2*240/490.
add("autojunk-all-popular", "a" * 250, "a" * 240)

# --- seeded random pairs over a small alphabet, both directions --------------
random.seed(20260705)
for length in (30, 80, 150, 220, 350):
    a = "".join(random.choice("abcde ") for _ in range(length))
    b_chars = list(a)
    for _ in range(max(1, length // 10)):
        op = random.choice(("ins", "del", "sub"))
        pos = random.randrange(len(b_chars))
        if op == "ins":
            b_chars.insert(pos, random.choice("abcde "))
        elif op == "del" and len(b_chars) > 1:
            del b_chars[pos]
        else:
            b_chars[pos] = random.choice("abcde ")
    b = "".join(b_chars)
    add(f"random-{length}", a, b)
    add(f"random-{length}-rev", b, a)

out = pathlib.Path(__file__).with_name("sequence_ratio_vectors.json")
out.write_text(
    json.dumps({"generator_python": sys.version.split()[0], "cases": cases}, indent=2) + "\n",
    encoding="utf-8",
    newline="\n",
)
print(f"wrote {len(cases)} cases to {out}")
