export function jsonErrorHandler(error, request, response, next) {
  if (response.headersSent) {
    next(error);
    return;
  }
  console.error("Unhandled PULSO API request error", {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    type: error?.name,
    code: error?.code,
  });
  response.status(500).json({
    error: "internal_error",
    message: "Não foi possível concluir a solicitação.",
    requestId: request.requestId,
  });
}
