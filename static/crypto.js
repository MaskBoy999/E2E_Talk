console.log('crypto.js v6 loaded - X25519 + XChaCha20-Poly1305, true E2EE');
const E2ECrypto = (() => {
    // --- Base64 helpers ---
    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }
    function base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }
    function concatBuffers() {
        const bufs = [];
        for (let i = 0; i < arguments.length; i++) bufs.push(new Uint8Array(arguments[i]));
        let total = 0;
        for (const b of bufs) total += b.length;
        const r = new Uint8Array(total);
        let off = 0;
        for (const b of bufs) { r.set(b, off); off += b.length; }
        return r;
    }
    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }
    function randomBytes(n) {
        var r = new Uint8Array(n);
        crypto.getRandomValues(r);
        return r;
    }

    // --- SHA-256 ---
    var K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    function sha256(message) {
        var msg = new Uint8Array(message);
        var bitLen = msg.length * 8;
        var padLen = Math.ceil((msg.length + 9) / 64) * 64;
        var padded = new Uint8Array(padLen);
        padded.set(msg);
        padded[msg.length] = 0x80;
        var dv = new DataView(padded.buffer);
        dv.setUint32(padLen - 4, bitLen, false);
        var h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a;
        var h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
        var w = new Int32Array(64);
        for (var i = 0; i < padLen; i += 64) {
            for (var j = 0; j < 16; j++) w[j] = dv.getInt32(i + j * 4, false);
            for (var j = 16; j < 64; j++) {
                var s0=((w[j-15]>>>7)|(w[j-15]<<25))^((w[j-15]>>>18)|(w[j-15]<<14))^(w[j-15]>>>3);
                var s1=((w[j-2]>>>17)|(w[j-2]<<15))^((w[j-2]>>>19)|(w[j-2]<<13))^(w[j-2]>>>10);
                w[j]=(w[j-16]+s0+w[j-7]+s1)|0;
            }
            var a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
            for (var j = 0; j < 64; j++) {
                var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
                var ch=(e&f)^(~e&g);
                var t1=(h+S1+ch+K[j]+w[j])|0;
                var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
                var maj=(a&b)^(a&c)^(b&c);
                var t2=(S0+maj)|0;
                h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
            }
            h0=(h0+a)|0;h1=(h1+b)|0;h2=(h2+c)|0;h3=(h3+d)|0;
            h4=(h4+e)|0;h5=(h5+f)|0;h6=(h6+g)|0;h7=(h7+h)|0;
        }
        var r=new Uint8Array(32);var rv=new DataView(r.buffer);
        rv.setUint32(0,h0,false);rv.setUint32(4,h1,false);
        rv.setUint32(8,h2,false);rv.setUint32(12,h3,false);
        rv.setUint32(16,h4,false);rv.setUint32(20,h5,false);
        rv.setUint32(24,h6,false);rv.setUint32(28,h7,false);
        return r;
    }

    // --- HMAC-SHA256 ---
    function hmacSHA256(keyBytes, msgBytes) {
        var bl = 64;
        var k;
        if (keyBytes.length > bl) { k = sha256(keyBytes); }
        else { k = new Uint8Array(bl); k.set(keyBytes); }
        var ipad = new Uint8Array(bl), opad = new Uint8Array(bl);
        for (var i = 0; i < bl; i++) { ipad[i] = k[i] ^ 0x36; opad[i] = k[i] ^ 0x5c; }
        var innerHash = sha256(concatBuffers(ipad, msgBytes));
        return sha256(concatBuffers(opad, innerHash));
    }

    // --- HKDF-SHA256 ---
    function hkdf(ikm, salt, info, len) {
        var prk = hmacSHA256(salt, ikm);
        var infoBytes = new TextEncoder().encode(info);
        var t = hmacSHA256(prk, concatBuffers(infoBytes, new Uint8Array([0x01])));
        return t.slice(0, len || 32);
    }

    // --- X25519 (Curve25519 ECDH) ---
    var CURVE_P = (1n << 255n) - 19n;
    var CURVE_A486662 = 486662n;
    var CURVE_A24 = 121666n;
    var CURVE_ORDER = (1n << 255n) - 19n;
    var CURVE_BASE_POINT = 9n;

    function feMod(a) { return ((a % CURVE_P) + CURVE_P) % CURVE_P; }
    function feMul(a, b) { return feMod(a * b); }
    function feAdd(a, b) { return feMod(a + b); }
    function feSub(a, b) { return feMod(a - b); }
    function fePow(a, e) {
        var r = 1n;
        a = feMod(a);
        while (e > 0n) {
            if (e & 1n) r = feMul(r, a);
            e >>= 1n;
            a = feMul(a, a);
        }
        return r;
    }
    function feInv(a) { return fePow(a, CURVE_P - 2n); }

    function bytesToBigInt(bytes) {
        var hex = '';
        for (var i = bytes.length - 1; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');
        return BigInt('0x' + hex);
    }
    function bigIntToBytes(num, len) {
        var hex = num.toString(16).padStart(len * 2, '0');
        var bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(hex.length - 2 - i * 2, 2), 16);
        return bytes;
    }

    function decodeUCoordinate(bytes) {
        var u = bytesToBigInt(bytes);
        u &= (1n << 255n) - 1n;
        return u;
    }
    function decodeScalar(bytes) {
        var k = bytesToBigInt(bytes);
        k &= ~7n;
        k &= ~(1n << 255n);
        k |= (1n << 254n);
        return k;
    }

    function x25519ScalarMult(scalar, u) {
        var x1 = u;
        var x2 = 1n, z2 = 0n;
        var x3 = u, z3 = 1n;
        var swap = 0;

        for (var t = 254; t >= 0; t--) {
            var k_t = (scalar >> BigInt(t)) & 1n;
            swap ^= Number(k_t);
            var dummy;
            if (swap) { dummy = x2; x2 = x3; x3 = dummy; dummy = z2; z2 = z3; z3 = dummy; }
            swap = Number(k_t);

            var A = feAdd(x2, z2);
            var AA = feMul(A, A);
            var B = feSub(x2, z2);
            var BB = feMul(B, B);
            var E = feSub(AA, BB);
            var C = feAdd(x3, z3);
            var D = feSub(x3, z3);
            var DA = feMul(D, A);
            var CB = feMul(C, B);
            x3 = feMul(feAdd(DA, CB), feAdd(DA, CB));
            z3 = feMul(x1, feMul(feSub(DA, CB), feSub(DA, CB)));
            x2 = feMul(AA, BB);
            z2 = feMul(E, feAdd(AA, feMul(CURVE_A24, E)));
        }

        if (swap) { var dummy = x2; x2 = x3; x3 = dummy; dummy = z2; z2 = z3; z3 = dummy; }
        return feMul(x2, feInv(z2));
    }

    function x25519SharedSecret(privateKeyBytes, publicKeyBytes) {
        var scalar = decodeScalar(privateKeyBytes);
        var u = decodeUCoordinate(publicKeyBytes);
        var result = x25519ScalarMult(scalar, u);
        return bigIntToBytes(result, 32);
    }

    function x25519GenerateKeyPair() {
        var privateKey = randomBytes(32);
        privateKey[0] &= 248;
        privateKey[31] &= 127;
        privateKey[31] |= 64;
        var scalar = bytesToBigInt(privateKey);
        var publicKey = bigIntToBytes(x25519ScalarMult(scalar, CURVE_BASE_POINT), 32);
        return { privateKey: privateKey, publicKey: publicKey };
    }

    function x25519DerivePublicKey(privateKeyBytes) {
        var scalar = bytesToBigInt(privateKeyBytes);
        return bigIntToBytes(x25519ScalarMult(scalar, CURVE_BASE_POINT), 32);
    }

    // --- ChaCha20 ---
    function chacha20QuarterRound(state, a, b, c, d) {
        state[a] = (state[a] + state[b]) | 0;
        state[d] = rotl32(state[d] ^ state[a], 16);
        state[c] = (state[c] + state[d]) | 0;
        state[b] = rotl32(state[b] ^ state[c], 12);
        state[a] = (state[a] + state[b]) | 0;
        state[d] = rotl32(state[d] ^ state[a], 8);
        state[c] = (state[c] + state[d]) | 0;
        state[b] = rotl32(state[b] ^ state[c], 7);
    }

    function rotl32(v, n) {
        return ((v << n) | (v >>> (32 - n))) | 0;
    }

    function chacha20Block(key, counter, nonce) {
        var state = new Int32Array(16);
        state[0] = 0x61707865;
        state[1] = 0x3320646e;
        state[2] = 0x79622d32;
        state[3] = 0x6b206574;
        var kv = new DataView(key.buffer, key.byteOffset);
        for (var i = 0; i < 8; i++) state[4 + i] = kv.getInt32(i * 4, true);
        state[12] = counter;
        var nv = new DataView(nonce.buffer, nonce.byteOffset);
        state[13] = nv.getInt32(0, true);
        state[14] = nv.getInt32(4, true);
        state[15] = nv.getInt32(8, true);

        var working = new Int32Array(state);
        for (var i = 0; i < 10; i++) {
            chacha20QuarterRound(working, 0, 4, 8, 12);
            chacha20QuarterRound(working, 1, 5, 9, 13);
            chacha20QuarterRound(working, 2, 6, 10, 14);
            chacha20QuarterRound(working, 3, 7, 11, 15);
            chacha20QuarterRound(working, 0, 5, 10, 15);
            chacha20QuarterRound(working, 1, 6, 11, 12);
            chacha20QuarterRound(working, 2, 7, 8, 13);
            chacha20QuarterRound(working, 3, 4, 9, 14);
        }

        var out = new Uint8Array(64);
        var ov = new DataView(out.buffer);
        for (var i = 0; i < 16; i++) {
            var v = (working[i] + state[i]) | 0;
            ov.setInt32(i * 4, v, true);
        }
        return out;
    }

    function chacha20Encrypt(key, counter, nonce, data) {
        var out = new Uint8Array(data.length);
        var blockCount = Math.ceil(data.length / 64);
        for (var i = 0; i < blockCount; i++) {
            var keystream = chacha20Block(key, counter + i, nonce);
            var start = i * 64;
            var len = Math.min(64, data.length - start);
            for (var j = 0; j < len; j++) out[start + j] = data[start + j] ^ keystream[j];
        }
        return out;
    }

    // --- HChaCha20 ---
    function hchacha20(key, input) {
        var state = new Int32Array(16);
        state[0] = 0x61707865;
        state[1] = 0x3320646e;
        state[2] = 0x79622d32;
        state[3] = 0x6b206574;
        var kv = new DataView(key.buffer, key.byteOffset);
        for (var i = 0; i < 8; i++) state[4 + i] = kv.getInt32(i * 4, true);
        var iv = new DataView(input.buffer, input.byteOffset);
        state[12] = iv.getInt32(0, true);
        state[13] = iv.getInt32(4, true);
        state[14] = iv.getInt32(8, true);
        state[15] = iv.getInt32(12, true);

        var working = new Int32Array(state);
        for (var i = 0; i < 10; i++) {
            chacha20QuarterRound(working, 0, 4, 8, 12);
            chacha20QuarterRound(working, 1, 5, 9, 13);
            chacha20QuarterRound(working, 2, 6, 10, 14);
            chacha20QuarterRound(working, 3, 7, 11, 15);
            chacha20QuarterRound(working, 0, 5, 10, 15);
            chacha20QuarterRound(working, 1, 6, 11, 12);
            chacha20QuarterRound(working, 2, 7, 8, 13);
            chacha20QuarterRound(working, 3, 4, 9, 14);
        }

        var out = new Uint8Array(32);
        var ov = new DataView(out.buffer);
        ov.setInt32(0, working[0], true);
        ov.setInt32(4, working[1], true);
        ov.setInt32(8, working[2], true);
        ov.setInt32(12, working[3], true);
        ov.setInt32(16, working[12], true);
        ov.setInt32(20, working[13], true);
        ov.setInt32(24, working[14], true);
        ov.setInt32(28, working[15], true);
        return out;
    }

    // --- Poly1305 ---
    function poly1305(key, data) {
        var r = new Uint8Array(16);
        r[0] = key[0] & 0xff; r[1] = key[1] & 0x0f;
        r[2] = key[2] & 0xfc; r[3] = key[3] & 0xf8;
        r[4] = key[4] & 0xfe; r[5] = key[5] & 0xff;
        r[6] = key[6] & 0xfe; r[7] = key[7] & 0xff;
        r[8] = key[8] & 0xfe; r[9] = key[9] & 0xff;
        r[10] = key[10] & 0xfe; r[11] = key[11] & 0xff;
        r[12] = key[12] & 0xfc; r[13] = key[13] & 0xff;
        r[14] = key[14] & 0xfe; r[15] = key[15] & 0xff;

        var s = new Uint8Array(16);
        s[0] = key[16]; s[1] = key[17]; s[2] = key[18]; s[3] = key[19];
        s[4] = key[20]; s[5] = key[21]; s[6] = key[22]; s[7] = key[23];
        s[8] = key[24]; s[9] = key[25]; s[10] = key[26]; s[11] = key[27];
        s[12] = key[28]; s[13] = key[29]; s[14] = key[30]; s[15] = key[31];

        var r0 = leBytesToNum(r, 0, 4);
        var r1 = leBytesToNum(r, 4, 8);
        var r2 = leBytesToNum(r, 8, 12);
        var r3 = leBytesToNum(r, 12, 16);

        var s1 = (r1 * 5) | 0;
        var s2 = (r2 * 5) | 0;
        var s3 = (r3 * 5) | 0;

        var h0 = 0, h1 = 0, h2 = 0, h3 = 0;

        var blocks = Math.ceil(data.length / 16);
        for (var i = 0; i < blocks; i++) {
            var block = new Uint8Array(16);
            var offset = i * 16;
            var blockLen = Math.min(16, data.length - offset);
            for (var j = 0; j < blockLen; j++) block[j] = data[offset + j];
            block[blockLen] = 1;

            var t0 = leBytesToNum(block, 0, 4);
            var t1 = leBytesToNum(block, 4, 8);
            var t2 = leBytesToNum(block, 8, 12);
            var t3 = leBytesToNum(block, 12, 16);

            h0 = (h0 + t0) | 0;
            h1 = (h1 + t1) | 0;
            h2 = (h2 + t2) | 0;
            h3 = (h3 + t3) | 0;

            var d0, d1, d2, d3, d4;

            d0 = mul32(h0, r0);
            d1 = mul32(h0, r1) + mul32(h1, r0);
            d2 = mul32(h0, r2) + mul32(h1, s1) + mul32(h2, r0);
            d3 = mul32(h0, r3) + mul32(h1, s2) + mul32(h2, s1) + mul32(h3, r0);
            d4 = mul32(h1, r3) + mul32(h2, s2) + mul32(h3, s1);

            h0 = d0 & 0xffffffff;
            h1 = d1 & 0xffffffff;
            h2 = d2 & 0xffffffff;
            h3 = d3 & 0xffffffff;

            var carry = (d0 - h0) * 0x100000000 + (d1 - h1) + (d2 - h2) * 0x100000000 + (d3 - h3) * 0x100000000;
            var carryWord = carry / 0x100000000;

            h0 = (h0 + (carryWord | 0) * 5) | 0;
            var c = (carryWord | 0);
            h1 = (h1 + c) | 0;

            h1 = (h1 + ((h0 - (h0 >>> 0)) / 0x100000000 | 0)) | 0;
            h0 = h0 >>> 0;
        }

        var g0 = h0 + 5; var c0 = g0 >>> 26; g0 = g0 & 0x3ffffff;
        var g1 = h1 + c0; var c1 = g1 >>> 26; g1 = g1 & 0x3ffffff;
        var g2 = h2 + c1; var c2 = g2 >>> 26; g2 = g2 & 0x3ffffff;
        var g3 = h3 + c2; var c3 = g3 >>> 26; g3 = g3 & 0x3ffffff;

        g0 = g0 - 0x3ffffff; var mask0 = (g0 >>> 26) & 1;
        g1 = g1 - c3 + mask0; var mask1 = (g1 >>> 26) & 1;
        g2 = g2 + mask1;

        g0 = (g0 & ~mask0) | ((g0 + 0x3ffffff) & mask0);
        g1 = (g1 & ~mask1) | ((g1 + 0x3ffffff) & mask1);

        h0 = r0 * g0 + s3 * g1 + s2 * g2 + s1 * g3;
        h1 = r1 * g0 + r0 * g1 + s3 * g2 + s2 * g3;
        h2 = r2 * g0 + r1 * g1 + r0 * g2 + s3 * g3;
        h3 = r3 * g0 + r2 * g1 + r1 * g2 + r0 * g3;

        h1 = (h1 + (h0 >>> 26)) | 0; h0 = h0 & 0x3ffffff;
        h2 = (h2 + (h1 >>> 26)) | 0; h1 = h1 & 0x3ffffff;
        h3 = (h3 + (h2 >>> 26)) | 0; h2 = h2 & 0x3ffffff;
        h0 = h0 + (h3 >>> 26) * 5; h3 = h3 & 0x3ffffff;
        h1 = (h1 + (h0 >>> 26)) | 0; h0 = h0 & 0x3ffffff;

        var result = new Uint8Array(16);
        numToLeBytes(result, 0, h0);
        numToLeBytes(result, 4, h1);
        numToLeBytes(result, 8, h2);
        numToLeBytes(result, 12, h3);

        var carry = 0;
        for (var i = 0; i < 16; i++) {
            carry += result[i] + s[i];
            result[i] = carry & 0xff;
            carry >>>= 8;
        }

        return result;
    }

    function leBytesToNum(bytes, start, end) {
        var result = 0;
        var factor = 1;
        for (var i = start; i < end; i++) {
            result += bytes[i] * factor;
            factor *= 256;
        }
        return result;
    }

    function numToLeBytes(bytes, offset, num) {
        bytes[offset] = num & 0xff;
        bytes[offset + 1] = (num >>> 8) & 0xff;
        bytes[offset + 2] = (num >>> 16) & 0xff;
        bytes[offset + 3] = (num >>> 24) & 0xff;
    }

    function mul32(a, b) {
        a = a | 0;
        b = b | 0;
        var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
        var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return (ah * bl + al * bh) * 0x10000 + al * bl;
    }

    // --- XChaCha20-Poly1305 ---
    function xchacha20poly1305Encrypt(key, plaintext) {
        var nonce = randomBytes(24);
        var subkey = hchacha20(key, nonce.subarray(0, 16));

        var paddedNonce = new Uint8Array(12);
        paddedNonce[4] = nonce[16]; paddedNonce[5] = nonce[17];
        paddedNonce[6] = nonce[18]; paddedNonce[7] = nonce[19];
        paddedNonce[8] = nonce[20]; paddedNonce[9] = nonce[21];
        paddedNonce[10] = nonce[22]; paddedNonce[11] = nonce[23];

        var ciphertext = chacha20Encrypt(subkey, 1, paddedNonce, plaintext);

        var polyKey = chacha20Block(subkey, 0, paddedNonce);
        var macData = new Uint8Array(ciphertext.length + (ciphertext.length % 16 === 0 ? 0 : 16 - (ciphertext.length % 16)) + 16);
        for (var i = 0; i < ciphertext.length; i++) macData[i] = ciphertext[i];
        macData[ciphertext.length] = 1;
        var cLen = new DataView(macData.buffer);
        cLen.setUint32(macData.length - 8, ciphertext.length, true);
        cLen.setUint32(macData.length - 4, 0, true);

        var tag = poly1305(polyKey, macData);

        return { ciphertext: ciphertext, tag: tag, nonce: nonce };
    }

    function xchacha20poly1305Decrypt(key, ciphertext, tag, nonce) {
        var subkey = hchacha20(key, nonce.subarray(0, 16));

        var paddedNonce = new Uint8Array(12);
        paddedNonce[4] = nonce[16]; paddedNonce[5] = nonce[17];
        paddedNonce[6] = nonce[18]; paddedNonce[7] = nonce[19];
        paddedNonce[8] = nonce[20]; paddedNonce[9] = nonce[21];
        paddedNonce[10] = nonce[22]; paddedNonce[11] = nonce[23];

        var polyKey = chacha20Block(subkey, 0, paddedNonce);
        var macData = new Uint8Array(ciphertext.length + (ciphertext.length % 16 === 0 ? 0 : 16 - (ciphertext.length % 16)) + 16);
        for (var i = 0; i < ciphertext.length; i++) macData[i] = ciphertext[i];
        macData[ciphertext.length] = 1;
        var cLen = new DataView(macData.buffer);
        cLen.setUint32(macData.length - 8, ciphertext.length, true);
        cLen.setUint32(macData.length - 4, 0, true);

        var expectedTag = poly1305(polyKey, macData);
        if (!equalBytes(tag, expectedTag)) throw new Error('Authentication failed');

        return chacha20Encrypt(subkey, 1, paddedNonce, ciphertext);
    }

    // --- Envelope Encryption (X25519 + XChaCha20-Poly1305) ---
    function envelopeEncrypt(plaintext, recipientPublicKey) {
        var ephemeral = x25519GenerateKeyPair();
        var sharedSecret = x25519SharedSecret(ephemeral.privateKey, recipientPublicKey);
        var info = new TextEncoder().encode('e2e-envelope-v1');
        var envelopeKey = hkdf(sharedSecret, sharedSecret, 'e2e-envelope-v1', 32);
        var plaintextBytes = new TextEncoder().encode(plaintext);
        var enc = xchacha20poly1305Encrypt(envelopeKey, plaintextBytes);
        var combined = concatBuffers(enc.ciphertext, enc.tag);
        return {
            ciphertext: arrayBufferToBase64(combined),
            nonce: arrayBufferToBase64(enc.nonce),
            ephemeralPublicKey: arrayBufferToBase64(ephemeral.publicKey)
        };
    }

    function envelopeDecrypt(ciphertextB64, nonceB64, ephemeralPublicKeyB64, recipientPrivateKey) {
        var ciphertext = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        var nonce = new Uint8Array(base64ToArrayBuffer(nonceB64));
        var ephemeralPub = new Uint8Array(base64ToArrayBuffer(ephemeralPublicKeyB64));
        if (ciphertext.length < 16) throw new Error('Ciphertext too short');
        var ct = ciphertext.slice(0, ciphertext.length - 16);
        var tag = ciphertext.slice(ciphertext.length - 16);
        var sharedSecret = x25519SharedSecret(recipientPrivateKey, ephemeralPub);
        var envelopeKey = hkdf(sharedSecret, sharedSecret, 'e2e-envelope-v1', 32);
        var plaintext = xchacha20poly1305Decrypt(envelopeKey, ct, tag, nonce);
        return new TextDecoder().decode(plaintext);
    }

    // --- Envelope encrypt raw bytes (for server keys) ---
    function envelopeEncryptRaw(plaintextBytes, recipientPublicKey) {
        var ephemeral = x25519GenerateKeyPair();
        var sharedSecret = x25519SharedSecret(ephemeral.privateKey, recipientPublicKey);
        var envelopeKey = hkdf(sharedSecret, sharedSecret, 'e2e-envelope-v1', 32);
        var enc = xchacha20poly1305Encrypt(envelopeKey, plaintextBytes);
        var combined = concatBuffers(enc.ciphertext, enc.tag);
        return {
            ciphertext: arrayBufferToBase64(combined),
            nonce: arrayBufferToBase64(enc.nonce),
            ephemeralPublicKey: arrayBufferToBase64(ephemeral.publicKey)
        };
    }

    function envelopeDecryptRaw(ciphertextB64, nonceB64, ephemeralPublicKeyB64, recipientPrivateKey) {
        var ciphertext = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        var nonce = new Uint8Array(base64ToArrayBuffer(nonceB64));
        var ephemeralPub = new Uint8Array(base64ToArrayBuffer(ephemeralPublicKeyB64));
        if (ciphertext.length < 16) throw new Error('Ciphertext too short');
        var ct = ciphertext.slice(0, ciphertext.length - 16);
        var tag = ciphertext.slice(ciphertext.length - 16);
        var sharedSecret = x25519SharedSecret(recipientPrivateKey, ephemeralPub);
        var envelopeKey = hkdf(sharedSecret, sharedSecret, 'e2e-envelope-v1', 32);
        return xchacha20poly1305Decrypt(envelopeKey, ct, tag, nonce);
    }

    // --- Per-Server Key Management ---
    function generateServerKey() {
        return randomBytes(32);
    }

    function deriveChannelKey(serverKey, channelId, messageNonce) {
        var info = 'e2e-channel-v1:' + channelId;
        if (messageNonce) info += ':' + messageNonce;
        return hkdf(serverKey, serverKey, info, 32);
    }

    function deriveMetadataKey(serverKey) {
        return hkdf(serverKey, serverKey, 'e2e-metadata-v1', 32);
    }

    // --- Encrypt/decrypt with server key ---
    function encryptWithKey(plaintext, key) {
        var plaintextBytes = new TextEncoder().encode(plaintext);
        var enc = xchacha20poly1305Encrypt(key, plaintextBytes);
        var combined = concatBuffers(enc.ciphertext, enc.tag);
        return {
            ciphertext: arrayBufferToBase64(combined),
            nonce: arrayBufferToBase64(enc.nonce)
        };
    }

    function encryptWithKeyAndNonce(plaintext, key, msgNonce) {
        var plaintextBytes = new TextEncoder().encode(plaintext);
        var enc = xchacha20poly1305Encrypt(key, plaintextBytes);
        var combined = concatBuffers(enc.ciphertext, enc.tag);
        return {
            ciphertext: arrayBufferToBase64(combined),
            nonce: arrayBufferToBase64(enc.nonce),
            messageNonce: msgNonce
        };
    }

    function decryptWithKey(ciphertextB64, nonceB64, key) {
        var combined = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        var nonce = new Uint8Array(base64ToArrayBuffer(nonceB64));
        if (combined.length < 16) throw new Error('Ciphertext too short');
        var ct = combined.slice(0, combined.length - 16);
        var tag = combined.slice(combined.length - 16);
        var plaintext = xchacha20poly1305Decrypt(key, ct, tag, nonce);
        return new TextDecoder().decode(plaintext);
    }

    // --- Key storage in localStorage ---
    // Identity keys are tied to an account, never to the browser as a whole.
    // This prevents logging into a second account from replacing the first
    // account's private key.
    function identityStorageSuffix(accountId) {
        if (accountId) return accountId;
        try {
            var currentUser = JSON.parse(localStorage.getItem('user') || 'null');
            return currentUser && currentUser.id ? currentUser.id : null;
        } catch (_) {
            return null;
        }
    }

    function getIdentityKeyPair(accountId) {
        var suffix = identityStorageSuffix(accountId);
        if (!suffix) return null;
        var priv = localStorage.getItem('e2e_identity_private_' + suffix);
        var pub = localStorage.getItem('e2e_identity_public_' + suffix);
        if (!priv || !pub) return null;
        return {
            privateKey: new Uint8Array(base64ToArrayBuffer(priv)),
            publicKey: new Uint8Array(base64ToArrayBuffer(pub))
        };
    }

    function saveIdentityKeyPair(kp, accountId) {
        var suffix = identityStorageSuffix(accountId);
        if (!suffix) throw new Error('Cannot save an identity key without an account id');
        localStorage.setItem('e2e_identity_private_' + suffix, arrayBufferToBase64(kp.privateKey));
        localStorage.setItem('e2e_identity_public_' + suffix, arrayBufferToBase64(kp.publicKey));
    }

    // One-time migration for the original single browser-wide key. The caller
    // must supply the account's public key returned by the server; this avoids
    // assigning a key belonging to a different account.
    function claimLegacyIdentityKey(accountId, expectedPublicKeyB64) {
        if (getIdentityKeyPair(accountId)) return true;
        var priv = localStorage.getItem('e2e_identity_private');
        var pub = localStorage.getItem('e2e_identity_public');
        if (!priv || !pub || pub !== expectedPublicKeyB64) return false;
        localStorage.setItem('e2e_identity_private_' + accountId, priv);
        localStorage.setItem('e2e_identity_public_' + accountId, pub);
        localStorage.removeItem('e2e_identity_private');
        localStorage.removeItem('e2e_identity_public');
        return true;
    }

    function getServerKey(serverId) {
        var key = localStorage.getItem('e2e_server_' + serverId);
        if (!key) return null;
        return new Uint8Array(base64ToArrayBuffer(key));
    }

    function saveServerKey(serverId, key) {
        var oldKey = localStorage.getItem('e2e_server_' + serverId);
        if (oldKey) {
            var history = JSON.parse(localStorage.getItem('e2e_server_history_' + serverId) || '[]');
            history.push(oldKey);
            localStorage.setItem('e2e_server_history_' + serverId, JSON.stringify(history));
        }
        localStorage.setItem('e2e_server_' + serverId, arrayBufferToBase64(key));
    }

    function getAllServerKeys(serverId) {
        var keys = [];
        var current = getServerKey(serverId);
        if (current) keys.push(current);
        var history = JSON.parse(localStorage.getItem('e2e_server_history_' + serverId) || '[]');
        for (var i = 0; i < history.length; i++) {
            keys.push(new Uint8Array(base64ToArrayBuffer(history[i])));
        }
        return keys;
    }

    function removeServerKey(serverId) {
        localStorage.removeItem('e2e_server_' + serverId);
        localStorage.removeItem('e2e_server_history_' + serverId);
    }

    // --- Public API ---
    function encrypt(plaintext, channelId, serverId) {
        var serverKey = getServerKey(serverId);
        if (!serverKey) throw new Error('No server key - cannot encrypt');
        var msgNonce = arrayBufferToBase64(randomBytes(16));
        var key = deriveChannelKey(serverKey, channelId, msgNonce);
        return encryptWithKeyAndNonce(plaintext, key, msgNonce);
    }

    function decrypt(ciphertextB64, nonceB64, channelId, serverId, messageNonce) {
        var allKeys = getAllServerKeys(serverId);
        if (allKeys.length === 0) throw new Error('No server keys - cannot decrypt');
        for (var i = 0; i < allKeys.length; i++) {
            try {
                var key = deriveChannelKey(allKeys[i], channelId, messageNonce);
                return decryptWithKey(ciphertextB64, nonceB64, key);
            } catch (_) {}
        }
        throw new Error('Decryption failed with all keys');
    }

    function encryptMetadata(plaintext, serverId) {
        var serverKey = getServerKey(serverId);
        if (!serverKey) throw new Error('No server key - cannot encrypt metadata');
        var key = deriveMetadataKey(serverKey);
        return encryptWithKey(plaintext, key);
    }

    function decryptMetadata(ciphertextB64, nonceB64, serverId) {
        var allKeys = getAllServerKeys(serverId);
        if (allKeys.length === 0) throw new Error('No server keys - cannot decrypt metadata');
        for (var i = 0; i < allKeys.length; i++) {
            try {
                var key = deriveMetadataKey(allKeys[i]);
                return decryptWithKey(ciphertextB64, nonceB64, key);
            } catch (_) {}
        }
        throw new Error('Metadata decryption failed with all keys');
    }

    // --- DM Encryption (ECDH shared secret + HKDF per-channel) ---
    function encryptDm(plaintext, dmChannelId, myPrivateKey, otherPublicKey) {
        var shared = x25519SharedSecret(myPrivateKey, otherPublicKey);
        var msgNonce = arrayBufferToBase64(randomBytes(16));
        var key = hkdf(shared, shared, 'e2e-dm-v1:' + dmChannelId + ':' + msgNonce, 32);
        return encryptWithKeyAndNonce(plaintext, key, msgNonce);
    }

    function decryptDm(ciphertextB64, nonceB64, dmChannelId, myPrivateKey, otherPublicKey, messageNonce) {
        var shared = x25519SharedSecret(myPrivateKey, otherPublicKey);
        var info = 'e2e-dm-v1:' + dmChannelId;
        if (messageNonce) info += ':' + messageNonce;
        var key = hkdf(shared, shared, info, 32);
        return decryptWithKey(ciphertextB64, nonceB64, key);
    }

    // --- File Encryption (XChaCha20-Poly1305 chunked) ---
    function generateFileKey() {
        return randomBytes(32);
    }

    // Encrypt a single chunk. Returns Uint8Array: [24-byte nonce] + [ciphertext] + [16-byte tag]
    function encryptFileChunk(fileKey, plaintextChunk) {
        var enc = xchacha20poly1305Encrypt(fileKey, plaintextChunk);
        var combined = concatBuffers(enc.nonce, enc.ciphertext, enc.tag);
        return combined;
    }

    // Decrypt a single chunk. Input: Uint8Array from encryptFileChunk.
    function decryptFileChunk(fileKey, encryptedChunk) {
        if (encryptedChunk.length < 40) throw new Error('Encrypted chunk too short');
        var nonce = encryptedChunk.slice(0, 24);
        var tag = encryptedChunk.slice(encryptedChunk.length - 16);
        var ciphertext = encryptedChunk.slice(24, encryptedChunk.length - 16);
        return xchacha20poly1305Decrypt(fileKey, ciphertext, tag, nonce);
    }

    // --- TOFU Key Verification ---
    function getKnownFingerprints() {
        try { return JSON.parse(localStorage.getItem('known_key_fingerprints') || '{}'); }
        catch { return {}; }
    }
    function saveKnownFingerprints(obj) {
        localStorage.setItem('known_key_fingerprints', JSON.stringify(obj));
    }
    function fingerprintKey(pubKeyB64) {
        var raw = base64ToArrayBuffer(pubKeyB64);
        var bytes = new Uint8Array(raw);
        var hash = [];
        for (var i = 0; i < Math.min(bytes.length, 8); i++) hash.push(bytes[i].toString(16).padStart(2, '0'));
        return hash.join(':');
    }
    function verifyKeyForUser(userId, pubKeyB64) {
        var known = getKnownFingerprints();
        var fp = fingerprintKey(pubKeyB64);
        if (known[userId] === undefined) {
            known[userId] = fp;
            saveKnownFingerprints(known);
            return { trusted: true, newKey: true };
        }
        if (known[userId] === fp) {
            return { trusted: true, newKey: false };
        }
        return { trusted: false, newKey: false, storedFingerprint: known[userId], currentFingerprint: fp };
    }
    function trustCurrentKey(userId, pubKeyB64) {
        var known = getKnownFingerprints();
        known[userId] = fingerprintKey(pubKeyB64);
        saveKnownFingerprints(known);
    }

    return {
        sha256Hex: function(data) {
            var bytes = new TextEncoder().encode(data);
            var hash = sha256(bytes);
            var hex = '';
            for (var i = 0; i < hash.length; i++) hex += hash[i].toString(16).padStart(2, '0');
            return hex;
        },
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        randomBytes: randomBytes,
        x25519GenerateKeyPair: x25519GenerateKeyPair,
        x25519DerivePublicKey: x25519DerivePublicKey,
        x25519SharedSecret: x25519SharedSecret,
        envelopeEncrypt: envelopeEncrypt,
        envelopeDecrypt: envelopeDecrypt,
        envelopeEncryptRaw: envelopeEncryptRaw,
        envelopeDecryptRaw: envelopeDecryptRaw,
        generateServerKey: generateServerKey,
        deriveChannelKey: deriveChannelKey,
        deriveMetadataKey: deriveMetadataKey,
        encryptWithKey: encryptWithKey,
        encryptWithKeyAndNonce: encryptWithKeyAndNonce,
        decryptWithKey: decryptWithKey,
        getIdentityKeyPair: getIdentityKeyPair,
        saveIdentityKeyPair: saveIdentityKeyPair,
        claimLegacyIdentityKey: claimLegacyIdentityKey,
        getServerKey: getServerKey,
        getAllServerKeys: getAllServerKeys,
        saveServerKey: saveServerKey,
        removeServerKey: removeServerKey,
        encrypt: encrypt,
        decrypt: decrypt,
        encryptMetadata: encryptMetadata,
        decryptMetadata: decryptMetadata,
        encryptDm: encryptDm,
        decryptDm: decryptDm,
        generateFileKey: generateFileKey,
        encryptFileChunk: encryptFileChunk,
        decryptFileChunk: decryptFileChunk,
        verifyKeyForUser: verifyKeyForUser,
        trustCurrentKey: trustCurrentKey,
        fingerprintKey: fingerprintKey
    };
})();
