use axum::http::{header::ORIGIN, HeaderMap, Method};
use subtle::ConstantTimeEq;

use crate::{
    config::Config,
    http::{ApiError, ApiResult},
};

pub fn check_origin(config: &Config, headers: &HeaderMap) -> ApiResult<()> {
    if let Some(url) = &config.public_url {
        let expected = url.origin().ascii_serialization();
        if headers.get(ORIGIN).and_then(|value| value.to_str().ok()) != Some(expected.as_str()) {
            return Err(ApiError::forbidden(
                "Request origin does not match the server URL",
            ));
        }
    }
    Ok(())
}

pub fn check_session(method: &Method, headers: &HeaderMap, expected: &str) -> ApiResult<()> {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return Ok(());
    }
    let valid = headers
        .get("x-lt-csrf")
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(expected.as_bytes())));
    if !valid {
        return Err(ApiError::forbidden("Missing or invalid CSRF token"));
    }
    Ok(())
}
