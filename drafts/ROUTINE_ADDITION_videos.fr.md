# Addition routine — vidéos (`videos`)

À ajouter dans la section Photos du prompt de la routine « Réponses Discord », et à mentionner dans la liste du payload (section Démarrage).

## Dans la liste du payload (section Démarrage)

Inclure `videos` et `attachments_summary` à côté de `images`.

Dans les scripts de secours, ajouter :

```bash
/workspace/discord-bridge/vid.sh <url>
```

## Texte à ajouter dans la section Photos


## Vidéos (`videos` dans le payload)

- Mêmes conditions que les photos : présent seulement si le message t'est adressé (mention, alias, réponse à un de tes messages, DM) ou s'il s'agit d'un suivi de conversation humain (`trigger: "follow"`). Jamais pour un autre bot, jamais pour un déclencheur ambiant.
- `videos` : jusqu'à 2 vidéos, chacune avec `url`, `filename`, `content_type` (`video/mp4` | `video/quicktime` | `video/webm`), `width`, `height`, `size` (octets), `duration` (secondes, si disponible), `proxy_url`, et `thumbnail` (aperçu) si Discord ou l'embed en fournit un. Même structure dans `referenced.videos`. Les fichiers de plus de 25 Mo sont exclus du champ `videos` (ils restent décrits dans `attachments_summary`).
- Les pièces jointes vidéo (mp4, mov depuis iPhone, webm) et les embeds vidéo / gifv (Tenor, Giphy, Discord) sont inclus. Un gif classique (`image/gif`) reste dans `images`, pas dans `videos`.
- `attachments_summary` liste les pièces jointes, vidéos et stickers (nom, type, taille), sans URL. Si le message n'a pas de texte, `content` contient une annotation du type `[vidéo: clip.mov]` : ce n'est PAS un message vide.
- Un message peut n'être qu'une vidéo (peu ou pas de texte) : si le pont t'a réveillé, tu y réponds quand même, en fonction de ce que montrent les images clés.
- Pour voir une vidéo : `/workspace/discord-bridge/vid.sh <url>` avec une `url` du payload (`cdn.discordapp.com`, `media.discordapp.net`, tenor ou giphy uniquement). Le script télécharge le fichier (max 25 Mo, 20 s), en extrait 3 à 4 images JPEG réparties sur la durée, et affiche `duration_s=…`, `frames=…`, puis les chemins locaux. Ouvre ensuite 2 ou 3 de ces images (Read) pour voir le contenu. Ne l'appelle pas si tu n'as pas besoin de voir la vidéo, et jamais pour une URL hors payload / hors hôtes autorisés. Le cache est purgé après 24 h.
- Le script n'extrait pas le son et ne transcrit pas l'audio. Ne prétends jamais avoir entendu un dialogue, une musique ou un bruit : tu n'as vu que des images.
- Mêmes limites de contenu que les photos.
