defmodule MyApp.Web.Greeter do
  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def greet(name) do
    "Hello, #{name}!"
  end
end
