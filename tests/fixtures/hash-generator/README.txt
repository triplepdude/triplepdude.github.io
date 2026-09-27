blake3-test-vectors.json: the official BLAKE3 test vectors,
https://github.com/BLAKE3-team/BLAKE3/blob/master/test_vectors/test_vectors.json
(BLAKE3 is released under CC0 1.0 or Apache 2.0).

python-vectors.json: Keccak-256 computed with pycryptodome (Crypto.Hash.keccak), BLAKE3 with the
official blake3 Python package, keyed BLAKE2 with Python's hashlib. The inputs are described in
tests/tools/hash-generator.test.js.
