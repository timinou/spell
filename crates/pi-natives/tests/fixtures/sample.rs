pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Point {
    pub fn origin() -> Self {
        Point { x: 0.0, y: 0.0 }
    }
}

pub trait Drawable {
    fn draw(&self);
}

impl Drawable for Point {
    fn draw(&self) {
        println!("({}, {})", self.x, self.y);
    }
}

#[test]
fn test_origin() {
    let p = Point::origin();
    assert_eq!(p.x, 0.0);
}
