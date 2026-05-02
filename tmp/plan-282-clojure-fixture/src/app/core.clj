(ns app.core
  (:require [app.db :as db]
            [app.protocols :refer [fetch!]]))

(defn normalize-name [s]
  (db/connect!)
  (fetch! s)
  {:user/id s})
