//! Password derivation uses Workers' native Web Crypto, not a slow WASM KDF.
//! This preserves existing 600k-iteration credentials without weakening the policy.
use crate::http::{Failure, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/src/runtime/security.js")]
extern "C" {
    #[wasm_bindgen(js_name=authRandom)]
    fn random(n: u32) -> Vec<u8>;
    #[wasm_bindgen(js_name=authUuid)]
    pub fn uuid() -> String;
    #[wasm_bindgen(catch, js_name=authDerive)]
    async fn derive(password: &str, salt: &[u8]) -> std::result::Result<JsValue, JsValue>;
}
pub fn hash(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
pub fn challenge(s: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(s.as_bytes()))
}
pub fn secret() -> String {
    URL_SAFE_NO_PAD.encode(random(32))
}
pub const VERSION: &str = "{pbkdf2-sha256-600k-v1}";
pub fn normalized(raw: &str) -> Option<String> {
    let value: String = raw.nfc().collect();
    (raw.encode_utf16().count() <= 512 && value.chars().count() <= 128).then_some(value)
}
async fn bits(raw: &str, salt: &[u8]) -> Result<Vec<u8>> {
    let v = derive(raw, salt).await.map_err(|_| Failure {
        status: 503,
        code: "AUTH_UNAVAILABLE",
    })?;
    Ok(js_sys::Uint8Array::new(&v).to_vec())
}
pub async fn matches(raw: &str, encoded: &str) -> Result<bool> {
    let Some(value) = normalized(raw) else {
        bits("invalid-password-input", &[0; 16]).await?;
        return Ok(false);
    };
    let Some(raw_hex) = encoded.strip_prefix(VERSION) else {
        return Ok(false);
    };
    let Ok(bytes) = hex::decode(raw_hex) else {
        return Ok(false);
    };
    if bytes.len() != 48 || raw_hex.bytes().any(|b| b.is_ascii_uppercase()) {
        return Ok(false);
    }
    let actual = bits(&value, &bytes[..16]).await?;
    let diff = actual
        .iter()
        .zip(&bytes[16..])
        .fold(0u8, |a, (b, c)| a | (b ^ c));
    Ok(actual.len() == 32 && diff == 0)
}
pub async fn encode(raw: &str) -> Result<String> {
    let value = normalized(raw).ok_or(Failure {
        status: 400,
        code: "INVALID_PASSWORD",
    })?;
    if value.chars().count() < 8 {
        return Err(Failure {
            status: 400,
            code: "INVALID_PASSWORD",
        });
    }
    let common = [
        "password",
        "password1",
        "password123",
        "password1234",
        "password!",
        "p@ssw0rd",
        "p@ssword",
        "12345678",
        "123456789",
        "1234567890",
        "12345678910",
        "87654321",
        "qwertyui",
        "qwertyuiop",
        "qwerty123",
        "qwerty12345",
        "abcdefgh",
        "abc12345",
        "abc123456",
        "iloveyou",
        "admin123",
        "admin1234",
        "admin12345",
        "adminadmin",
        "letmein1",
        "welcome1",
        "welcome123",
        "changeme",
        "changeme123",
        "asdfghjk",
        "asdfghjkl",
    ];
    let lower = value.to_lowercase();
    let digest = hash(&lower);
    if value.chars().all(|c| Some(c) == value.chars().next())
        || common.contains(&lower.as_str())
        || include_str!("password-blocklist.txt")
            .lines()
            .any(|h| h == digest)
    {
        return Err(Failure {
            status: 400,
            code: "PASSWORD_BLOCKED",
        });
    }
    let salt = random(16);
    Ok(format!(
        "{VERSION}{}{}",
        hex::encode(&salt),
        hex::encode(bits(&value, &salt).await?)
    ))
}

pub fn avatar(value: &serde_json::Value) -> Result<serde_json::Value> {
    use crate::http::{ensure, string};
    if value.is_null() {
        return Ok(serde_json::Value::Null);
    }
    let error = || Failure {
        status: 400,
        code: "INVALID_AVATAR",
    };
    let input = string(value, 180000).map_err(|_| error())?;
    let data = input
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(error)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| error())?;
    ensure(
        bytes.len() >= 24 && bytes[..8] == [137, 80, 78, 71, 13, 10, 26, 10],
        400,
        "INVALID_AVATAR",
    )?;
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    ensure(
        (1..=256).contains(&width) && (1..=256).contains(&height),
        400,
        "INVALID_AVATAR",
    )?;
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 2 * 1024 * 1024,
    });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|_| error())?;
    let size = reader.output_buffer_size().ok_or_else(error)?;
    ensure(size <= 256 * 256 * 8, 400, "INVALID_AVATAR")?;
    let mut buf = vec![0; size];
    let info = reader.next_frame(&mut buf).map_err(|_| error())?;
    let mut clean = vec![];
    {
        let mut encoder = png::Encoder::new(&mut clean, info.width, info.height);
        encoder.set_color(info.color_type);
        encoder.set_depth(info.bit_depth);
        let mut writer = encoder.write_header().map_err(|_| error())?;
        writer
            .write_image_data(&buf[..info.buffer_size()])
            .map_err(|_| error())?;
    }
    ensure(clean.len() <= 135000, 400, "INVALID_AVATAR")?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(clean)
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_sha256() {
        assert_eq!(
            hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    #[test]
    fn pkce_rfc7636() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn password_nfc() {
        assert_eq!(normalized("e\u{301}"), Some("é".into()));
        assert!(normalized(&"a".repeat(129)).is_none());
    }
}
