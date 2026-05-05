package sample

type Rectangle struct {
	Width  float64
	Height float64
}

func (r Rectangle) Area() float64 {
	return r.Width * r.Height
}

type Shape interface {
	Area() float64
}

func NewRectangle(w, h float64) Rectangle {
	defer func() {}()
	return Rectangle{Width: w, Height: h}
}
