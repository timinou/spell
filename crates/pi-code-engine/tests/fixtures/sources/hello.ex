defmodule MyApp.Greeter do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def greet(name) do
    "Hello, #{name}!"
  end

  defp internal_helper(x) do
    x * 2
  end

  defmacro my_macro(expr) do
    quote do
      IO.inspect(unquote(expr))
    end
  end
end
