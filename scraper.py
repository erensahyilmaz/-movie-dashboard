import cloudscraper
from bs4 import BeautifulSoup
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

class LetterboxdScraper:
    def __init__(self, username):
        self.username = username
        # Letterboxd is behind Cloudflare; a plain requests.get returns a 403
        # "Just a moment..." challenge page. cloudscraper solves the JS challenge.
        # One shared session is reused across all requests so the Cloudflare
        # clearance token is kept (re-solving per request is slow).
        self.session = cloudscraper.create_scraper(
            browser={"browser": "chrome", "platform": "windows", "mobile": False}
        )

        self.progress = {
            "current_page": 0,
            "total_pages": 0,
            "current_film": 0,
            "total_films": 0,
            "percentage": 0,
            "done": False,
            "error": None,
            "stage": "initializing"  # initializing, counting, scraping_films, scraping_details, done
        }
        self.lock = threading.Lock()
    
    def set_error(self, error_msg):
        with self.lock:
            self.progress["error"] = error_msg
            self.progress["done"] = True
    
    def get_progress(self):
        with self.lock:
            return self.progress.copy()
    
    def update_progress(self, **kwargs):
        with self.lock:
            self.progress.update(kwargs)
            
            # Calculate overall percentage
            if self.progress["total_pages"] > 0 and self.progress["total_films"] > 0:
                # 30% for page scraping, 70% for detail scraping
                page_progress = (self.progress["current_page"] / self.progress["total_pages"]) * 30
                film_progress = (self.progress["current_film"] / self.progress["total_films"]) * 70
                self.progress["percentage"] = int(page_progress + film_progress)
    
    def get_clean_url(self, film_href):
        if not film_href:
            return None
        match = re.search(r"/film/([^/]+)/", film_href)
        if match:
            return f"https://letterboxd.com/film/{match.group(1)}"
        return None
    
    def count_total_pages(self):
        """Count how many pages of diary entries exist"""
        try:
            url = f"https://letterboxd.com/{self.username}/films/diary/"
            r = self.session.get(url, timeout=30)
            soup = BeautifulSoup(r.text, "html.parser")
            
            # Find pagination
            pagination = soup.select_one("div.paginate-pages")
            if pagination:
                page_links = pagination.select("a")
                if page_links:
                    # Get the last page number
                    last_page = 1
                    for link in page_links:
                        try:
                            page_num = int(link.text.strip())
                            last_page = max(last_page, page_num)
                        except ValueError:
                            continue
                    return last_page
            
            # If no pagination, there's only 1 page
            return 1
        except Exception as e:
            raise Exception(f"Failed to count pages: {str(e)}")
    
    def scrape_diary_page(self, page_num):
        """Scrape a single diary page"""
        try:
            url = f"https://letterboxd.com/{self.username}/films/diary/page/{page_num}/"
            r = self.session.get(url, timeout=30)
            soup = BeautifulSoup(r.text, "html.parser")
            
            films = []
            for row in soup.select("tr.diary-entry-row"):
                # Letterboxd moved the title into h2.primaryname (was h2.name)
                title_elem = row.select_one("h2.primaryname a") or row.select_one("td.col-production h2 a")
                date_elem = row.select_one("td.col-daydate a")
                rating_elem = row.select_one("span.rating")
                
                if title_elem:
                    films.append({
                        # Unique id of this diary viewing - used to detect which
                        # entries are already cached during an incremental refresh.
                        "entry_id": row.get("data-viewing-id") or row.get("data-object-id"),
                        "date": date_elem["href"].split("for/")[-1] if date_elem else None,
                        "title": title_elem.text.strip() if title_elem else None,
                        "rating": rating_elem.text.strip() if rating_elem else None,
                        "url": self.get_clean_url(title_elem["href"])
                    })
            
            return films
        except Exception as e:
            print(f"Error scraping page {page_num}: {e}")
            return []
    
    def scrape_film_details(self, film_url):
        """Scrape detailed information for a single film"""
        try:
            r = self.session.get(film_url, timeout=30)
            soup = BeautifulSoup(r.content, "html.parser")
            
            # Genres
            genres = ", ".join(
                a.text.strip() for a in soup.select("div.text-sluglist a[href*='/films/genre/']")
            ) or None
            
            # Cast
            cast = ", ".join(
                a.text.strip() for a in soup.select("div.cast-list a[href*='/actor/']")
            ) or None
            
            # Director - links to /director/ pages. They can appear more than
            # once on the page, so dedupe while preserving order.
            director_names = []
            for a in soup.select("a[href*='/director/']"):
                name = a.text.strip()
                if name and name not in director_names:
                    director_names.append(name)
            director = ", ".join(director_names) or None

            # Studios
            studios = ", ".join(
                a.text.strip() for a in soup.select("a[href*='/studio/']")
            ) or None

            # Year
            year_elem = soup.select_one("a[href*='/films/year/']") or soup.select_one("span.releasedate a")
            year = year_elem.text.strip() if year_elem else None
            
            return {
                "genres": genres,
                "cast": cast,
                "studios": studios,
                "director": director,
                "year": year
            }
        except Exception as e:
            print(f"Error scraping film details {film_url}: {e}")
            return {
                "genres": None,
                "cast": None,
                "studios": None,
                "director": None,
                "year": None
            }
    
    def scrape(self, known_ids=None):
        """Main scraping method.

        When ``known_ids`` is given (incremental refresh), diary pages are
        scraped newest-first and collection stops as soon as an already-cached
        entry is reached - only the new entries are returned.
        """
        known_ids = known_ids or set()
        incremental = bool(known_ids)
        try:
            # Stage 1: Count pages
            self.update_progress(stage="counting")
            total_pages = self.count_total_pages()
            self.update_progress(total_pages=total_pages, stage="scraping_films")

            # Stage 2: Scrape diary pages (stop early on a known entry if incremental)
            all_films = []
            reached_known = False
            for page in range(1, total_pages + 1):
                films = self.scrape_diary_page(page)
                for film in films:
                    if incremental and film.get("entry_id") in known_ids:
                        reached_known = True
                        break
                    all_films.append(film)
                self.update_progress(current_page=page)
                if reached_known:
                    break

            if not all_films:
                if incremental:
                    # Nothing new since the last refresh.
                    self.update_progress(done=True, percentage=100, stage="done")
                    return []
                raise Exception("No films found. Please check the username.")
            
            # Stage 3: Scrape film details
            self.update_progress(
                total_films=len(all_films),
                stage="scraping_details"
            )
            
            results = []
            
            # Use ThreadPoolExecutor for concurrent detail scraping
            with ThreadPoolExecutor(max_workers=5) as executor:
                future_to_film = {
                    executor.submit(self.scrape_film_details, film["url"]): film
                    for film in all_films if film["url"]
                }
                
                completed = 0
                for future in as_completed(future_to_film):
                    film = future_to_film[future]
                    try:
                        details = future.result()
                        results.append({**film, **details})
                    except Exception as e:
                        print(f"Failed to get details for {film['title']}: {e}")
                        results.append({
                            **film,
                            "genres": None,
                            "cast": None,
                            "studios": None,
                            "director": None,
                            "year": None
                        })
                    
                    completed += 1
                    self.update_progress(current_film=completed)
            
            # Complete
            self.update_progress(
                done=True,
                percentage=100,
                stage="done"
            )
            
            return results
            
        except Exception as e:
            self.set_error(str(e))
            raise