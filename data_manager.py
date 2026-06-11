import threading

class DataManager:
    def __init__(self):
        self.data = []
        self.lock = threading.Lock()
    
    def set_data(self, data):
        with self.lock:
            self.data = data
    
    def get_data(self):
        with self.lock:
            return self.data.copy()
    
    def get_filter_options(self):
        """Extract unique values for each filterable field"""
        with self.lock:
            if not self.data:
                return {}
            
            studios_set = set()
            cast_set = set()
            directors_set = set()
            genres_set = set()
            
            for film in self.data:
                # Studios
                if film.get("studios"):
                    for studio in film["studios"].split(", "):
                        studios_set.add(studio.strip())
                
                # Cast
                if film.get("cast"):
                    for actor in film["cast"].split(", "):
                        cast_set.add(actor.strip())
                
                # Directors
                if film.get("director"):
                    for director in film["director"].split(", "):
                        directors_set.add(director.strip())
                
                # Genres
                if film.get("genres"):
                    for genre in film["genres"].split(", "):
                        genres_set.add(genre.strip())
            
            return {
                "studios": sorted(list(studios_set)),
                "cast": sorted(list(cast_set)),
                "directors": sorted(list(directors_set)),
                "genres": sorted(list(genres_set))
            }
    
    def filter_data(self, filters):
        """
        Filter data based on provided filters
        filters = {
            "studios": ["Marvel Studios", "Warner Bros."],
            "cast": ["Mark Ruffalo"],
            "directors": [],
            "genres": ["Action"],
            "search": "avengers"
        }
        """
        with self.lock:
            if not self.data:
                return []
            
            filtered = self.data.copy()
            
            # Search filter (title search)
            if filters.get("search"):
                search_term = filters["search"].lower()
                filtered = [
                    f for f in filtered 
                    if f.get("title") and search_term in f["title"].lower()
                ]
            
            # Studio filter
            if filters.get("studios"):
                filtered = [
                    f for f in filtered
                    if f.get("studios") and any(
                        studio in f["studios"] for studio in filters["studios"]
                    )
                ]
            
            # Cast filter
            if filters.get("cast"):
                filtered = [
                    f for f in filtered
                    if f.get("cast") and any(
                        actor in f["cast"] for actor in filters["cast"]
                    )
                ]
            
            # Director filter
            if filters.get("directors"):
                filtered = [
                    f for f in filtered
                    if f.get("director") and any(
                        director in f["director"] for director in filters["directors"]
                    )
                ]
            
            # Genre filter
            if filters.get("genres"):
                filtered = [
                    f for f in filtered
                    if f.get("genres") and any(
                        genre in f["genres"] for genre in filters["genres"]
                    )
                ]
            
            return filtered