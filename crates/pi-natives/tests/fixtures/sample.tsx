// TSX fixture: JSX parsed via typescript dialect.
import React from "react";

export const Banner: React.FC<{ title: string }> = ({ title }) => {
  return <header className="banner"><h1>{title}</h1></header>;
};
