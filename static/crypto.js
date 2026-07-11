console.log('crypto.js v4 loaded - pure JS, no crypto.subtle needed');
const E2ECrypto = (() => {
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
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
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

    // --- AES-128 ---
    var SBOX=[0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
    var RCON=[0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];
    function xtime(a){return((a<<1)^(((a>>7)&1)*0x1b))&0xff;}

    function keyExpansion(key) {
        var nk = key.length / 4, nr = nk + 6;
        var w = new Uint8Array(16 * (nr + 1));
        w.set(key);
        for (var i = nk; i < 4 * (nr + 1); i++) {
            var t = w.slice((i-1)*4, i*4);
            if (i % nk === 0) {
                var t0=SBOX[t[1]]^RCON[i/nk-1], t1=SBOX[t[2]], t2=SBOX[t[3]], t3=SBOX[t[0]];
                t[0]=t0;t[1]=t1;t[2]=t2;t[3]=t3;
            } else if (nk > 6 && i % nk === 4) {
                t[0]=SBOX[t[0]];t[1]=SBOX[t[1]];t[2]=SBOX[t[2]];t[3]=SBOX[t[3]];
            }
            for (var j = 0; j < 4; j++) w[i*4+j] = w[(i-nk)*4+j] ^ t[j];
        }
        return {w:w, nr:nr};
    }

    function aesBlock(block, ek) {
        var s = new Uint8Array(block);
        var nr = ek.nr, w = ek.w;
        for (var j=0;j<16;j++) s[j]^=w[j];
        for (var rd=1;rd<nr;rd++) {
            for (var i=0;i<16;i++) s[i]=SBOX[s[i]];
            var tmp=new Uint8Array(16);
            tmp[0]=s[0]^s[5]^s[10]^s[15]^xtime(s[0]^s[5]);
            tmp[1]=s[1]^s[6]^s[11]^s[12]^xtime(s[1]^s[6]);
            tmp[2]=s[2]^s[7]^s[8]^s[13]^xtime(s[2]^s[7]);
            tmp[3]=s[3]^s[4]^s[9]^s[14]^xtime(s[3]^s[4]);
            tmp[4]=s[4]^s[0]^s[5]^s[10]^xtime(s[4]^s[0]);
            tmp[5]=s[5]^s[1]^s[6]^s[11]^xtime(s[5]^s[1]);
            tmp[6]=s[6]^s[2]^s[7]^s[12]^xtime(s[6]^s[2]);
            tmp[7]=s[7]^s[3]^s[8]^s[13]^xtime(s[7]^s[3]);
            tmp[8]=s[8]^s[4]^s[9]^s[14]^xtime(s[8]^s[4]);
            tmp[9]=s[9]^s[5]^s[10]^s[15]^xtime(s[9]^s[5]);
            tmp[10]=s[10]^s[6]^s[11]^s[12]^xtime(s[10]^s[6]);
            tmp[11]=s[11]^s[7]^s[8]^s[13]^xtime(s[11]^s[7]);
            tmp[12]=s[12]^s[0]^s[5]^s[10]^xtime(s[12]^s[0]);
            tmp[13]=s[13]^s[1]^s[6]^s[11]^xtime(s[13]^s[1]);
            tmp[14]=s[14]^s[2]^s[7]^s[12]^xtime(s[14]^s[2]);
            tmp[15]=s[15]^s[3]^s[8]^s[13]^xtime(s[15]^s[3]);
            for(var j=0;j<16;j++) s[j]=tmp[j];
            for(var j=0;j<16;j++) s[j]^=w[rd*16+j];
        }
        for (var i=0;i<16;i++) s[i]=SBOX[s[i]];
        var tmp=new Uint8Array(16);
        tmp[0]=s[0]^s[5]^s[10]^s[15];tmp[1]=s[1]^s[6]^s[11]^s[12];tmp[2]=s[2]^s[7]^s[8]^s[13];tmp[3]=s[3]^s[4]^s[9]^s[14];
        tmp[4]=s[4]^s[0]^s[5]^s[10];tmp[5]=s[5]^s[1]^s[6]^s[11];tmp[6]=s[6]^s[2]^s[7]^s[12];tmp[7]=s[7]^s[3]^s[8]^s[13];
        tmp[8]=s[8]^s[4]^s[9]^s[14];tmp[9]=s[9]^s[5]^s[10]^s[15];tmp[10]=s[10]^s[6]^s[11]^s[12];tmp[11]=s[11]^s[7]^s[8]^s[13];
        tmp[12]=s[12]^s[0]^s[5]^s[10];tmp[13]=s[13]^s[1]^s[6]^s[11];tmp[14]=s[14]^s[2]^s[7]^s[12];tmp[15]=s[15]^s[3]^s[8]^s[13];
        for(var j=0;j<16;j++) s[j]=tmp[j];
        for(var j=0;j<16;j++) s[j]^=w[nr*16+j];
        return s;
    }

    // --- AES-128-CTR ---
    function aesCtr128(keyBytes, iv, data) {
        var ek = keyExpansion(keyBytes);
        var counter = new Uint8Array(iv);
        var out = new Uint8Array(data.length);
        for (var pos = 0; pos < data.length; pos += 16) {
            var keystream = aesBlock(counter, ek);
            var len = Math.min(16, data.length - pos);
            for (var i = 0; i < len; i++) out[pos+i] = data[pos+i] ^ keystream[i];
            for (var i = 15; i >= 0; i--) { counter[i]++; if (counter[i] !== 0) break; }
        }
        return out;
    }

    // --- Encrypt/Decrypt ---
    function deriveKeys(channelId) {
        var salt = new TextEncoder().encode('e2e-chat-v4-salt');
        var keyBytes = hkdf(salt, salt, channelId, 32);
        return { encKey: keyBytes.slice(0, 16), macKey: keyBytes.slice(16, 32) };
    }

    function encrypt(plaintext, channelId) {
        var keys = deriveKeys(channelId);
        var iv = crypto.getRandomValues(new Uint8Array(16));
        var ct = aesCtr128(keys.encKey, iv, new TextEncoder().encode(plaintext));
        var tag = hmacSHA256(keys.macKey, concatBuffers(iv, ct));
        var tagSlice = tag.slice(0, 16);
        var combined = concatBuffers(ct, tagSlice);
        return {
            ciphertext: arrayBufferToBase64(combined),
            nonce: arrayBufferToBase64(iv)
        };
    }

    function decrypt(ciphertextB64, nonceB64, channelId) {
        var keys = deriveKeys(channelId);
        var combined = new Uint8Array(base64ToArrayBuffer(ciphertextB64));
        var iv = new Uint8Array(base64ToArrayBuffer(nonceB64));
        if (combined.length < 16) throw new Error('Ciphertext too short');
        var ct = combined.slice(0, combined.length - 16);
        var tag = combined.slice(combined.length - 16);
        var expectedTag = hmacSHA256(keys.macKey, concatBuffers(iv, ct)).slice(0, 16);
        if (!equalBytes(tag, expectedTag)) throw new Error('Authentication failed');
        var pt = aesCtr128(keys.encKey, iv, ct);
        return new TextDecoder().decode(pt);
    }

    return {
        arrayBufferToBase64: arrayBufferToBase64,
        base64ToArrayBuffer: base64ToArrayBuffer,
        encrypt: encrypt,
        decrypt: decrypt
    };
})();
