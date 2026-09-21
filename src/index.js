export default {
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "techcalc-blob-transformer",
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  },
};
