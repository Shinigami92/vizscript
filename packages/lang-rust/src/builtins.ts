/**
 * Methods of Rust's standard types as trait stubs, parsed like a file: what
 * the type lookup needs to follow values (`name.to_uppercase()` is a
 * `String`, `items.first()` an `Option<&Item>`). `T` is the item type, `K`
 * and `V` a map's key and value types, `E` an error type. `Self` stands for
 * the type itself (`f64::round` returns an `f64`). Iterators are `Iter<T>`.
 */
export const RUST_BUILTINS = `
trait str {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool;
    fn to_string(&self) -> String;
    fn to_owned(&self) -> String;
    fn to_uppercase(&self) -> String;
    fn to_lowercase(&self) -> String;
    fn trim(&self) -> &str;
    fn trim_start(&self) -> &str;
    fn trim_end(&self) -> &str;
    fn contains(&self, pattern: &str) -> bool;
    fn starts_with(&self, pattern: &str) -> bool;
    fn ends_with(&self, pattern: &str) -> bool;
    fn find(&self, pattern: &str) -> Option<usize>;
    fn replace(&self, from: &str, to: &str) -> String;
    fn repeat(&self, n: usize) -> String;
    fn chars(&self) -> Iter<char>;
    fn bytes(&self) -> Iter<u8>;
    fn lines(&self) -> Iter<&str>;
    fn split(&self, pattern: &str) -> Iter<&str>;
    fn split_whitespace(&self) -> Iter<&str>;
    fn as_str(&self) -> &str;
    fn clone(&self) -> Self;
}

trait String {
    fn push(&mut self, ch: char);
    fn push_str(&mut self, string: &str);
    fn clear(&mut self);
    fn capacity(&self) -> usize;
}

trait Vec<T> {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool;
    fn push(&mut self, value: T);
    fn pop(&mut self) -> Option<T>;
    fn insert(&mut self, index: usize, element: T);
    fn remove(&mut self, index: usize) -> T;
    fn clear(&mut self);
    fn first(&self) -> Option<&T>;
    fn last(&self) -> Option<&T>;
    fn get(&self, index: usize) -> Option<&T>;
    fn contains(&self, x: &T) -> bool;
    fn iter(&self) -> Iter<&T>;
    fn iter_mut(&mut self) -> Iter<&mut T>;
    fn into_iter(self) -> Iter<T>;
    fn sort(&mut self);
    fn reverse(&mut self);
    fn join(&self, separator: &str) -> String;
    fn to_vec(&self) -> Vec<T>;
    fn clone(&self) -> Self;
}

trait Option<T> {
    fn is_some(&self) -> bool;
    fn is_none(&self) -> bool;
    fn unwrap(self) -> T;
    fn expect(self, msg: &str) -> T;
    fn unwrap_or(self, default: T) -> T;
    fn unwrap_or_default(self) -> T;
    fn ok_or(self, err: E) -> Result<T, E>;
    fn cloned(self) -> Option<T>;
    fn take(&mut self) -> Option<T>;
}

trait Result<T, E> {
    fn is_ok(&self) -> bool;
    fn is_err(&self) -> bool;
    fn ok(self) -> Option<T>;
    fn err(self) -> Option<E>;
    fn unwrap(self) -> T;
    fn expect(self, msg: &str) -> T;
    fn unwrap_or(self, default: T) -> T;
    fn unwrap_or_default(self) -> T;
    fn unwrap_err(self) -> E;
}

trait HashMap<K, V> {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool;
    fn get(&self, key: &K) -> Option<&V>;
    fn get_mut(&mut self, key: &K) -> Option<&mut V>;
    fn insert(&mut self, key: K, value: V) -> Option<V>;
    fn remove(&mut self, key: &K) -> Option<V>;
    fn contains_key(&self, key: &K) -> bool;
    fn keys(&self) -> Iter<&K>;
    fn values(&self) -> Iter<&V>;
    fn iter(&self) -> Iter<(&K, &V)>;
    fn clear(&mut self);
}

trait HashSet<T> {
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool;
    fn insert(&mut self, value: T) -> bool;
    fn remove(&mut self, value: &T) -> bool;
    fn contains(&self, value: &T) -> bool;
    fn iter(&self) -> Iter<&T>;
}

trait Iter<T> {
    fn next(&mut self) -> Option<T>;
    fn count(self) -> usize;
    fn rev(self) -> Iter<T>;
    fn skip(self, n: usize) -> Iter<T>;
    fn take(self, n: usize) -> Iter<T>;
    fn filter(self, predicate: P) -> Iter<T>;
    fn cloned(self) -> Iter<T>;
    fn copied(self) -> Iter<T>;
    fn enumerate(self) -> Iter<(usize, T)>;
    fn peekable(self) -> Iter<T>;
    fn find(&mut self, predicate: P) -> Option<T>;
    fn position(&mut self, predicate: P) -> Option<usize>;
    fn any(&mut self, f: F) -> bool;
    fn all(&mut self, f: F) -> bool;
    fn max(self) -> Option<T>;
    fn min(self) -> Option<T>;
    fn last(self) -> Option<T>;
    fn sum(self) -> T;
    fn product(self) -> T;
}

trait f64 {
    fn abs(self) -> Self;
    fn round(self) -> Self;
    fn floor(self) -> Self;
    fn ceil(self) -> Self;
    fn trunc(self) -> Self;
    fn sqrt(self) -> Self;
    fn powi(self, n: i32) -> Self;
    fn powf(self, n: Self) -> Self;
    fn sin(self) -> Self;
    fn cos(self) -> Self;
    fn min(self, other: Self) -> Self;
    fn max(self, other: Self) -> Self;
    fn clamp(self, min: Self, max: Self) -> Self;
    fn is_nan(self) -> bool;
    fn to_string(&self) -> String;
}

trait i64 {
    fn abs(self) -> Self;
    fn pow(self, exp: u32) -> Self;
    fn min(self, other: Self) -> Self;
    fn max(self, other: Self) -> Self;
    fn clamp(self, min: Self, max: Self) -> Self;
    fn signum(self) -> Self;
    fn is_positive(self) -> bool;
    fn is_negative(self) -> bool;
    fn to_string(&self) -> String;
}

trait bool {
    fn then_some(self, t: T) -> Option<T>;
    fn to_string(&self) -> String;
}

trait char {
    fn is_alphabetic(self) -> bool;
    fn is_numeric(self) -> bool;
    fn is_whitespace(self) -> bool;
    fn to_digit(self, radix: u32) -> Option<u32>;
    fn to_string(&self) -> String;
}
`;
