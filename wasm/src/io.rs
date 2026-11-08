//! The values the exports take from JS and give back.
//!
//! An export's data inputs and results are `Js<T>`: a JS value with the
//! shape that `T` decodes from or serializes to, so the export list in
//! lib.rs names the model's types. An input is decoded in the export's body
//! (`decode()?`), so a value of the wrong shape comes back as the export's
//! error, with serde's message; a result is serialized when it is made
//! (`Js::new`). Across the boundary `Js<T>` is a plain `JsValue`: the type
//! costs nothing at run time.

use serde::Serialize;
use serde::de::DeserializeOwned;
use std::marker::PhantomData;
use wasm_bindgen::JsValue;
use wasm_bindgen::convert::{FromWasmAbi, IntoWasmAbi};
use wasm_bindgen::describe::WasmDescribe;

/// Plain objects for maps, `null` for a JS null field. Fields the JS leaves
/// undefined are skipped by their `skip_serializing_if`.
pub fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new()
        .serialize_missing_as_null(true)
        .serialize_maps_as_objects(true);
    Ok(value.serialize(&serializer)?)
}

/// A JS value of shape `T`.
///
/// `T` is contravariant (`fn(T)`), so a result serialized from a view that
/// borrows the model (`SearchOut<'a>`) is named `Js<SearchOut<'static>>` in
/// an export: once serialized, the value borrows nothing.
pub struct Js<T>(JsValue, PhantomData<fn(T)>);

impl<T: Serialize> Js<T> {
    pub fn new(value: &T) -> Result<Js<T>, JsValue> {
        Ok(Js(to_js(value)?, PhantomData))
    }
}

impl<T: DeserializeOwned> Js<T> {
    pub fn decode(self) -> Result<T, JsValue> {
        Ok(serde_wasm_bindgen::from_value(self.0)?)
    }
}

impl<T> Js<T> {
    /// The value as it came over, not decoded.
    pub fn value(&self) -> &JsValue {
        &self.0
    }
    pub fn into_value(self) -> JsValue {
        self.0
    }
}

impl<T> WasmDescribe for Js<T> {
    fn describe() {
        JsValue::describe();
    }
}

impl<T> IntoWasmAbi for Js<T> {
    type Abi = <JsValue as IntoWasmAbi>::Abi;
    fn into_abi(self) -> Self::Abi {
        self.0.into_abi()
    }
}

impl<T> FromWasmAbi for Js<T> {
    type Abi = <JsValue as FromWasmAbi>::Abi;
    unsafe fn from_abi(js: Self::Abi) -> Self {
        // SAFETY: the ABI value is a JsValue's, handed over by the glue.
        Js(unsafe { JsValue::from_abi(js) }, PhantomData)
    }
}
