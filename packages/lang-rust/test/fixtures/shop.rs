use std::collections::HashMap;
use crate::util::{round, Money as Cents};

/// Tax added to every order.
const TAX_RATE: f64 = 0.19;

#[derive(Debug, Clone)]
pub struct Item {
    pub name: String,
    pub price: f64,
    quantity: u32,
}

impl Item {
    pub fn new(name: &str, price: f64) -> Self {
        Self { name: name.to_string(), price, quantity: 1 }
    }

    pub fn total(&self) -> f64 {
        self.price * self.quantity as f64
    }
}

pub fn total_price(items: &[Item], discount: f64) -> f64 {
    let mut total = 0.0;
    for item in items {
        // Out of stock items are not charged
        if item.quantity == 0 {
            continue;
        }
        total += item.total();
    }
    let discounted = total - total * discount;
    round(discounted * (1.0 + TAX_RATE))
}

pub fn find(items: &[Item], name: &str) -> Option<usize> {
    if let Some(index) = items.iter().position(|i| i.name == name) {
        println!("found {} at {}", name, index);
        return Some(index);
    }
    None
}

fn label(count: usize) -> &'static str {
    match count {
        0 => "empty",
        1 | 2 => "small",
        _ => {
            "big"
        }
    }
}

fn main() {
    let cart = vec![Item::new("Keyboard", 89.9), Item::new("Cable", 4.5)];
    let by_name: HashMap<String, f64> = HashMap::new();
    println!("Total: {} EUR", total_price(&cart, 0.1));
    while let Some(item) = cart.last() {
        println!("{}", item.name);
        break;
    }
}
