import {registerMiniapp} from "@mentra/miniapp/background"

import {LinkLingoController} from "./LinkLingoController"

registerMiniapp((session) => {
  void new LinkLingoController(session).start()
})
