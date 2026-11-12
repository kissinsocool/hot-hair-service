// 理发师、店铺动态的收藏；店铺收藏沿用 client.js 里的 /api/favorites 与 /api/favorites/:id。
module.exports = (app, ctx) => {
  const {
    normalizeUserId,
    readFavoriteTargetIds,
    setFavoriteTarget,
    favoriteTargetExists,
    readFavoriteStaff,
    readFavoritePosts,
    countStaffFavorites,
  } = ctx;

  const kinds = [
    { path: 'staff', kind: 'staff', idsKey: 'staffIds', label: '理发师', readList: readFavoriteStaff },
    { path: 'posts', kind: 'posts', idsKey: 'postIds', label: '动态', readList: readFavoritePosts },
  ];

  kinds.forEach(({ path, kind, idsKey, label, readList }) => {
    app.get(`/api/favorites/${path}`, async (req, res) => {
      res.json(await readList(normalizeUserId(req.clientUser.id)));
    });

    app.get(`/api/favorites/${path}/ids`, async (req, res) => {
      res.json({ [idsKey]: await readFavoriteTargetIds(kind, normalizeUserId(req.clientUser.id)) });
    });

    const write = favorite => async (req, res) => {
      const userId = normalizeUserId(req.clientUser.id);
      const targetId = String(req.params.id || '').trim();
      if (!targetId) return res.status(400).json({ message: `${label}信息无效` });
      if (favorite && !await favoriteTargetExists(kind, targetId)) {
        return res.status(404).json({ message: `${label}不存在或已下线` });
      }
      await setFavoriteTarget(kind, userId, targetId, favorite);
      const body = { favorite };
      if (kind === 'staff') body.favoriteCount = await countStaffFavorites(targetId);
      res.json(body);
    };

    app.put(`/api/favorites/${path}/:id`, write(true));
    app.delete(`/api/favorites/${path}/:id`, write(false));
  });
};
